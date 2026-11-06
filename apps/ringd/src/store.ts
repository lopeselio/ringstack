/**
 * ringd's SQLite state (node:sqlite, no native deps):
 *   snapshots  one sealed wallet snapshot per wallet (SDK-encrypted)
 *   events     append-only, unique per (wallet, id) so re-derivation is idempotent
 *   deliveries one row per (webhook, event), created with the event in one transaction
 */
import { DatabaseSync } from "node:sqlite";

import type { WalletStateStore } from "@heliuslabs/spr";

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
create table if not exists deliveries (
  webhook         text not null,
  event_seq       integer not null references events (seq),
  status          text not null check (status in ('pending', 'delivered', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at integer not null,
  last_status     integer,
  last_error      text,
  delivered_at    integer,
  primary key (webhook, event_seq)
);
create index if not exists deliveries_due on deliveries (status, next_attempt_at);
`;

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface Delivery {
  readonly webhook: string;
  readonly seq: number;
  readonly event: RingdEvent;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatus?: number;
  readonly lastError?: string;
}

interface DeliveryRow {
  webhook: string;
  event_seq: number;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
}

function toDelivery(r: DeliveryRow): Delivery {
  return {
    webhook: r.webhook,
    seq: r.event_seq,
    event: JSON.parse(r.payload) as RingdEvent,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    ...(r.last_status === null ? {} : { lastStatus: r.last_status }),
    ...(r.last_error === null ? {} : { lastError: r.last_error }),
  };
}

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

  /**
   * Insert events not seen before and, for each, a pending delivery per webhook
   * that `route` names, in one transaction. Returns only the new events.
   */
  appendEvents(events: readonly RingdEvent[], route: (e: RingdEvent) => readonly string[] = () => []): StoredEvent[] {
    if (events.length === 0) return [];
    const insert = this.#db.prepare(
      "insert or ignore into events (wallet, id, type, payload, created_at) values (?, ?, ?, ?, ?)",
    );
    const enqueue = this.#db.prepare(
      "insert or ignore into deliveries (webhook, event_seq, status, next_attempt_at) values (?, ?, 'pending', ?)",
    );
    const added: StoredEvent[] = [];
    const now = Date.now();
    this.#db.exec("begin");
    try {
      for (const e of events) {
        const r = insert.run(e.wallet, e.id, e.type, JSON.stringify(e), Date.parse(e.createdAt));
        if (r.changes === 0) continue;
        const seq = Number(r.lastInsertRowid);
        for (const webhook of route(e)) enqueue.run(webhook, seq, now);
        added.push({ seq, event: e });
      }
      this.#db.exec("commit");
    } catch (err) {
      this.#db.exec("rollback");
      throw err;
    }
    return added;
  }

  /** Pending deliveries due at `now` for the given webhooks, oldest event first. */
  dueDeliveries(webhooks: readonly string[], now: number, limit = 100): Delivery[] {
    if (webhooks.length === 0) return [];
    const marks = webhooks.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `select d.*, e.payload from deliveries d join events e on e.seq = d.event_seq
         where d.status = 'pending' and d.next_attempt_at <= ? and d.webhook in (${marks})
         order by d.event_seq limit ?`,
      )
      .all(now, ...webhooks, limit) as unknown as DeliveryRow[];
    return rows.map(toDelivery);
  }

  /** Record one attempt's outcome. `nextAttemptAt` undefined means no retry: delivered or failed. */
  recordAttempt(
    webhook: string,
    seq: number,
    outcome: Readonly<{ ok: boolean; status?: number; error?: string; nextAttemptAt?: number }>,
  ): void {
    const status: DeliveryStatus = outcome.ok ? "delivered" : outcome.nextAttemptAt === undefined ? "failed" : "pending";
    this.#db
      .prepare(
        `update deliveries set status = ?, attempts = attempts + 1, next_attempt_at = ?,
           last_status = ?, last_error = ?, delivered_at = ?
         where webhook = ? and event_seq = ?`,
      )
      .run(
        status,
        outcome.nextAttemptAt ?? Date.now(),
        outcome.status ?? null,
        outcome.error ?? null,
        outcome.ok ? Date.now() : null,
        webhook,
        seq,
      );
  }

  /** Put failed deliveries of a webhook back in the queue. Returns how many. */
  retryFailed(webhook: string): number {
    return Number(
      this.#db
        .prepare("update deliveries set status = 'pending', attempts = 0, next_attempt_at = ? where webhook = ? and status = 'failed'")
        .run(Date.now(), webhook).changes,
    );
  }

  listDeliveries(options: Readonly<{ webhook?: string; status?: DeliveryStatus; limit?: number }> = {}): Delivery[] {
    const rows = this.#db
      .prepare(
        `select d.*, e.payload from deliveries d join events e on e.seq = d.event_seq
         where (? is null or d.webhook = ?) and (? is null or d.status = ?)
         order by d.event_seq, d.webhook limit ?`,
      )
      .all(
        options.webhook ?? null,
        options.webhook ?? null,
        options.status ?? null,
        options.status ?? null,
        options.limit ?? 1000,
      ) as unknown as DeliveryRow[];
    return rows.map(toDelivery);
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
