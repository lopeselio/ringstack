/**
 * The ringd poll loop: for each watched wallet, sync (the SDK persists the
 * sealed snapshot only after a sync commits), derive events for history rows
 * not yet stored, append them, and hand the new ones to `onEvent`.
 *
 * Restart safety: cursors live in the snapshot and events are derived from the
 * full history against the events table, so a crash between saving the
 * snapshot and appending events is repaired on the next cycle.
 */
import {
  LocalKeys,
  MergeEncryptionScheme,
  NullifierKey,
  ViewingKey,
  Wallet,
  createZolanaClient,
  keyedWalletSnapshotCipher,
  loadPersistedWallet,
  syncPersistedWallet,
  walletSnapshotKey,
  type WalletStateCipher,
  type ZolanaClientConfig,
} from "@heliuslabs/zolana";

import { bytes31, bytes32 } from "@heliuslabs/zolana/keypair";
import { fetchUserRecord } from "@heliuslabs/zolana/wallet";
import {
  buildMerge,
  loadShieldedKeypair,
  ownerAddress,
  readKeyFile,
  spendableUtxos,
  submitTransaction,
  type WatchKeys,
} from "@ringstack/core";
import type { Address, TransactionPartialSigner } from "@solana/kit";

import {
  DEFAULT_DELIVERY,
  type DeliveryConfig,
  type MergeConfig,
  type WalletConfig,
  type WebhookConfig,
} from "./config.ts";
import { newEvents, type RingdEvent } from "./events.ts";
import type { RingdStore, StoredEvent } from "./store.ts";
import { Dispatcher, routeFor, type DispatchResult } from "./webhooks.ts";

type Client = Awaited<ReturnType<typeof createZolanaClient>>;

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON lines on stdout/stderr. */
export const jsonLogger: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: "info", msg, ...fields, ts: new Date().toISOString() })),
  error: (msg, fields) =>
    console.error(JSON.stringify({ level: "error", msg, ...fields, ts: new Date().toISOString() })),
};

class WatchedWallet {
  /** True until the first successful sync of a wallet that had no snapshot. */
  #firstSync: boolean;

  /** Logged once per run when merging is configured but the owner has not opted in. */
  #mergeDisabledLogged = false;

  private constructor(
    readonly name: string,
    readonly wallet: Wallet,
    readonly keys: WatchKeys,
    readonly cipher: WalletStateCipher,
    firstSync: boolean,
    readonly mergeThreshold: number | undefined,
  ) {
    this.#firstSync = firstSync;
  }

  static async open(config: WalletConfig, store: RingdStore): Promise<WatchedWallet> {
    const keys = await readKeyFile(config.keyFile);
    const cipher = keyedWalletSnapshotCipher(keys.address, await walletSnapshotKey(keys.viewingSecret.slice()));
    const restored = await loadPersistedWallet({ store: store.snapshotStore(config.name), cipher });
    if (restored !== undefined && !sameAddress(restored, keys)) {
      throw new Error(`wallet ${config.name}: stored snapshot belongs to a different address`);
    }
    const wallet = restored ?? new Wallet({ identity: keys.address });
    return new WatchedWallet(config.name, wallet, keys, cipher, restored === undefined, config.mergeThreshold);
  }

  /** Whether this wallet started without a stored snapshot (its first events are backfill). */
  get fresh(): boolean {
    return this.#firstSync;
  }

  async cycle(client: Client, store: RingdStore, route: (e: RingdEvent) => readonly string[]): Promise<StoredEvent[]> {
    await syncPersistedWallet({
      client,
      wallet: this.wallet,
      keys: this.keys.keys,
      store: store.snapshotStore(this.name),
      cipher: this.cipher,
    });
    const events = newEvents(this.name, this.wallet, store.knownEventIds(this.name), { backfill: this.#firstSync });
    this.#firstSync = false;
    return store.appendEvents(events, route);
  }

  /**
   * Merge an asset whose spendable UTXO count reached the threshold. Uses the
   * key file's viewing + nullifier keys and a separate fee payer: the owner's
   * spending key is never needed. Requires the owner's merge opt-in.
   */
  async maybeMerge(client: Client, feePayer: TransactionPartialSigner, maxInputs: number, log: Logger): Promise<void> {
    const threshold = this.mergeThreshold;
    if (threshold === undefined) return;
    const assets = new Set(this.wallet.utxos().filter((e) => !e.spent).map((e) => e.utxo.asset));
    const due = [...assets].filter((a) => spendableUtxos(this.wallet, a as Address).length >= threshold);
    if (due.length === 0) return;

    const owner = ownerAddress(this.keys.address);
    const record = await fetchUserRecord({ rpc: client, owner });
    if (record === undefined || record.mergeEncryption === MergeEncryptionScheme.Disabled) {
      if (!this.#mergeDisabledLogged) {
        log.error("merge skipped: owner has not enabled merging (setMerge / buildSetMergeEncryptionTransaction)", {
          wallet: this.name,
          owner,
        });
        this.#mergeDisabledLogged = true;
      }
      return;
    }

    for (const asset of due) {
      const nullifierKey = NullifierKey.fromSecret(bytes31(this.keys.nullifierSecret.slice()));
      const viewingKey = ViewingKey.fromBytes(bytes32(this.keys.viewingSecret.slice()));
      const proofKeys = LocalKeys.fromKeys(
        { address: this.keys.address, viewingKeys: [viewingKey], nullifierKey },
        client.proofService,
      );
      try {
        const built = await buildMerge({
          client,
          wallet: this.wallet,
          authority: { address: this.keys.address, nullifierKey },
          keys: proofKeys,
          feePayer: feePayer.address,
          asset: asset as Address,
          maxInputs,
        });
        const confirmed = await submitTransaction(client, [feePayer], built.transaction);
        log.info("merged", {
          wallet: this.name,
          asset,
          inputs: built.inputs,
          amount: built.amount.toString(),
          signature: confirmed.signature,
        });
      } finally {
        proofKeys.destroy();
        nullifierKey.destroy();
        viewingKey.destroy();
      }
    }
  }
}

function sameAddress(wallet: Wallet, keys: WatchKeys): boolean {
  const a = wallet.identity.toBytes();
  const b = keys.address.toBytes();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface DaemonOptions {
  readonly client: ZolanaClientConfig;
  readonly wallets: readonly WalletConfig[];
  readonly store: RingdStore;
  readonly pollIntervalMs: number;
  readonly log?: Logger;
  readonly onEvent?: (e: StoredEvent) => void | Promise<void>;
  readonly webhooks?: readonly WebhookConfig[];
  readonly delivery?: DeliveryConfig;
  readonly merge?: MergeConfig;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

export interface CycleResult {
  readonly events: StoredEvent[];
  readonly dispatch: DispatchResult;
}

export class Daemon {
  readonly #opts: DaemonOptions;
  readonly #log: Logger;
  #client?: Client;
  #watched: WatchedWallet[] = [];
  #mergeFeePayer?: TransactionPartialSigner;
  readonly #dispatcher: Dispatcher;
  readonly #route: (e: RingdEvent) => readonly string[];
  #stopped = false;
  #wake?: () => void;

  constructor(opts: DaemonOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? jsonLogger;
    const webhooks = opts.webhooks ?? [];
    this.#route = routeFor(webhooks);
    this.#dispatcher = new Dispatcher(opts.store, webhooks, opts.delivery ?? DEFAULT_DELIVERY, this.#log, opts.fetch);
  }

  async start(): Promise<void> {
    this.#client = await createZolanaClient(this.#opts.client);
    if (this.#opts.merge !== undefined) {
      this.#mergeFeePayer = (await loadShieldedKeypair(this.#opts.merge.feePayer)).toSolanaSigner();
      this.#log.info("merge fee payer", { address: this.#mergeFeePayer.address });
    }
    for (const w of this.#opts.wallets) {
      const watched = await WatchedWallet.open(w, this.#opts.store);
      this.#watched.push(watched);
      this.#log.info("watching", { wallet: w.name, restoredSnapshot: !watched.fresh });
    }
  }

  /**
   * One pass: sync every wallet (a failing wallet is logged and does not block
   * the others), then deliver due webhooks, including retries of older events.
   */
  async runOnce(): Promise<CycleResult> {
    const client = this.#client;
    if (client === undefined) throw new Error("daemon not started");
    const all: StoredEvent[] = [];
    for (const w of this.#watched) {
      try {
        const added = await w.cycle(client, this.#opts.store, this.#route);
        for (const e of added) {
          this.#log.info("event", { seq: e.seq, ...e.event });
          await this.#opts.onEvent?.(e);
        }
        all.push(...added);
      } catch (err) {
        this.#log.error("sync failed", { wallet: w.name, error: (err as Error).message });
        continue;
      }
      // After events are recorded, so a merged-away memo payment was already reported.
      if (this.#mergeFeePayer !== undefined && this.#opts.merge !== undefined) {
        try {
          await w.maybeMerge(client, this.#mergeFeePayer, this.#opts.merge.maxInputs, this.#log);
        } catch (err) {
          this.#log.error("merge failed", { wallet: w.name, error: (err as Error).message });
        }
      }
    }
    const dispatch = await this.#dispatcher.runOnce();
    return { events: all, dispatch };
  }

  /** Deliver due webhooks without syncing. */
  dispatch(): Promise<DispatchResult> {
    return this.#dispatcher.runOnce();
  }

  /** Poll until `stop()`. */
  async run(): Promise<void> {
    while (!this.#stopped) {
      await this.runOnce();
      if (this.#stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.#opts.pollIntervalMs);
        this.#wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }
}
