/**
 * ringd's SQLite state (node:sqlite, no native deps):
 *   snapshots  one sealed wallet snapshot per wallet (SDK-encrypted)
 *   events     append-only, unique per (wallet, id) so re-derivation is idempotent
 */
import { DatabaseSync } from "node:sqlite";

import type { WalletStateStore } from "@heliuslabs/zolana";

import type { RingdEvent } from "./events.ts";

const SCHEMA = `
create table if not exists snapshots (
  wallet     text primary key,
  sealed     text not null,
  updated_at integer not null
);
create table if not exists events (
  seq        integer primary key autoincrement,
  wallet     text not null,
  id         text not null,
  type       text not null,
  payload    text not null,
  created_at integer not null,
  unique (wallet, id)
);
`;

export interface StoredEvent {
  readonly seq: number;
  readonly event: RingdEvent;
}

export class RingdStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  /** The SDK's persistence boundary for one wallet. An upsert is atomic. */
  snapshotStore(wallet: string): WalletStateStore {
    const db = this.#db;
    return {
      async load() {
        const row = db.prepare("select sealed from snapshots where wallet = ?").get(wallet) as
          | { sealed: string }
          | undefined;
        return row?.sealed;
      },
      async save(sealed: string) {
        db.prepare(
          `insert into snapshots (wallet, sealed, updated_at) values (?, ?, ?)
           on conflict (wallet) do update set sealed = excluded.sealed, updated_at = excluded.updated_at`,
        ).run(wallet, sealed, Date.now());
      },
    };
  }

  /** Insert events not seen before, in one transaction. Returns only the new ones. */
  appendEvents(events: readonly RingdEvent[]): StoredEvent[] {
    if (events.length === 0) return [];
    const insert = this.#db.prepare(
      "insert or ignore into events (wallet, id, type, payload, created_at) values (?, ?, ?, ?, ?)",
    );
    const added: StoredEvent[] = [];
    this.#db.exec("begin");
    try {
      for (const e of events) {
        const r = insert.run(e.wallet, e.id, e.type, JSON.stringify(e), Date.parse(e.createdAt));
        if (r.changes > 0) added.push({ seq: Number(r.lastInsertRowid), event: e });
      }
      this.#db.exec("commit");
    } catch (err) {
      this.#db.exec("rollback");
      throw err;
    }
    return added;
  }

  knownEventIds(wallet: string): Set<string> {
    const rows = this.#db.prepare("select id from events where wallet = ?").all(wallet) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  listEvents(options: Readonly<{ wallet?: string; afterSeq?: number; limit?: number }> = {}): StoredEvent[] {
    const rows = this.#db
      .prepare(
        `select seq, payload from events
         where seq > ? and (? is null or wallet = ?)
         order by seq limit ?`,
      )
      .all(options.afterSeq ?? 0, options.wallet ?? null, options.wallet ?? null, options.limit ?? 1000) as {
      seq: number;
      payload: string;
    }[];
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as RingdEvent }));
  }
}
