/**
 * ringd.toml:
 *
 *   network = "localnet"            # or "devnet"
 *   database = "./ringd.db"         # relative to this file
 *   poll_interval_secs = 5
 *   # api_key comes from RINGD_API_KEY or API_KEY, never the file
 *
 *   [endpoints]                     # optional overrides
 *   rpc_url = "…"
 *   indexer_url = "…"
 *   prover_url = "…"
 *
 *   [[wallet]]
 *   name = "shop"
 *   key_file = "./shop.ringd-key.json"
 *   merge_threshold = 30            # optional: merge once this many spendable UTXOs of an asset pile up
 *
 *   [merge]                         # required when any wallet sets merge_threshold
 *   fee_payer = "./fee-payer.json"  # Solana keypair holding only SOL for fees, NOT the wallet owner's key
 *   max_inputs = 24                 # UTXOs per merge (2–24)
 *
 *   [[webhook]]
 *   name = "orders"
 *   url = "https://shop.example/hooks/ringd"   # http:// only for loopback hosts
 *   secret_env = "RINGD_WEBHOOK_SECRET"        # env var holding the HMAC secret
 *   wallets = ["shop"]                         # optional filter
 *   events = ["payment.received"]              # optional filter
 *
 *   [delivery]                                 # optional
 *   timeout_secs = 10
 *   max_attempts = 12
 *   retry_base_secs = 5                        # backoff: base * 2^(attempt-1), capped
 *   retry_max_secs = 3600
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SprClientConfig } from "@heliuslabs/spr";
import { clientConfig, type Network } from "@ringstack/core";
import type { RingdEventType } from "@ringstack/ringd-client";
import { parse } from "smol-toml";

export interface WalletConfig {
  readonly name: string;
  readonly keyFile: string;
  /** Merge once this many spendable UTXOs of one asset accumulate. Off when absent. */
  readonly mergeThreshold?: number;
}

export interface MergeConfig {
  /** Solana keypair file that pays merge fees. */
  readonly feePayer: string;
  readonly maxInputs: number;
}

export interface WebhookConfig {
  readonly name: string;
  readonly url: string;
  readonly secret: string;
  /** Only these wallets; all when absent. */
  readonly wallets?: readonly string[];
  /** Only these event types; all when absent. */
  readonly events?: readonly RingdEventType[];
}

export interface DeliveryConfig {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_DELIVERY: DeliveryConfig = {
  timeoutMs: 10_000,
  maxAttempts: 12,
  retryBaseMs: 5_000,
  retryMaxMs: 3_600_000,
};

const EVENT_TYPES: readonly RingdEventType[] = ["payment.received", "payment.sent", "utxo.merged", "wallet.activity"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface RingdConfig {
  readonly network: Network;
  readonly database: string;
  readonly pollIntervalMs: number;
  readonly client: SprClientConfig;
  readonly wallets: readonly WalletConfig[];
  readonly webhooks: readonly WebhookConfig[];
  readonly delivery: DeliveryConfig;
  readonly merge?: MergeConfig;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function str(table: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}.${key} must be a non-empty string`);
  return v.trim();
}

export function parseConfig(text: string, baseDir: string, env: NodeJS.ProcessEnv = process.env): RingdConfig {
  const doc = parse(text) as Record<string, unknown>;

  const network = (str(doc, "network", "config") ?? "localnet") as Network;
  if (network !== "localnet" && network !== "devnet") throw new Error(`network must be localnet or devnet`);

  const interval = doc["poll_interval_secs"] ?? 5;
  if (typeof interval !== "number" || !(interval >= 1)) throw new Error("poll_interval_secs must be a number ≥ 1");

  const endpoints = (doc["endpoints"] ?? {}) as Record<string, unknown>;
  const overrides = {
    rpcUrl: str(endpoints, "rpc_url", "endpoints"),
    indexerUrl: str(endpoints, "indexer_url", "endpoints"),
    proverUrl: str(endpoints, "prover_url", "endpoints"),
  };
  const apiKey = env["RINGD_API_KEY"]?.trim() || env["API_KEY"]?.trim() || undefined;

  const rawWallets = doc["wallet"];
  if (!Array.isArray(rawWallets) || rawWallets.length === 0) throw new Error("config needs at least one [[wallet]]");
  const wallets = rawWallets.map((w: Record<string, unknown>, i): WalletConfig => {
    const name = str(w, "name", `wallet[${i}]`);
    const keyFile = str(w, "key_file", `wallet[${i}]`);
    if (name === undefined || !NAME.test(name)) throw new Error(`wallet[${i}].name must match ${NAME}`);
    if (keyFile === undefined) throw new Error(`wallet[${i}].key_file is required`);
    const threshold = w["merge_threshold"];
    if (threshold !== undefined && (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 2)) {
      throw new Error(`wallet[${i}].merge_threshold must be an integer ≥ 2`);
    }
    return { name, keyFile: resolve(baseDir, keyFile), ...(threshold === undefined ? {} : { mergeThreshold: threshold }) };
  });
  const names = new Set(wallets.map((w) => w.name));
  if (names.size !== wallets.length) throw new Error("wallet names must be unique");

  const webhooks = parseWebhooks(doc["webhook"], names, env);
  const delivery = parseDelivery((doc["delivery"] ?? {}) as Record<string, unknown>);
  const merge = parseMerge(doc["merge"] as Record<string, unknown> | undefined, baseDir);
  if (merge === undefined && wallets.some((w) => w.mergeThreshold !== undefined)) {
    throw new Error("a wallet sets merge_threshold, so [merge] fee_payer is required");
  }

  return {
    network,
    database: resolve(baseDir, str(doc, "database", "config") ?? "./ringd.db"),
    pollIntervalMs: interval * 1000,
    client: clientConfig({ network, apiKey, overrides: stripUndefined(overrides) }),
    wallets,
    webhooks,
    delivery,
    ...(merge === undefined ? {} : { merge }),
  };
}

function parseMerge(t: Record<string, unknown> | undefined, baseDir: string): MergeConfig | undefined {
  if (t === undefined) return undefined;
  const feePayer = str(t, "fee_payer", "merge");
  if (feePayer === undefined) throw new Error("merge.fee_payer is required");
  const maxInputs = t["max_inputs"] ?? 24;
  if (typeof maxInputs !== "number" || !Number.isInteger(maxInputs) || maxInputs < 2 || maxInputs > 24) {
    throw new Error("merge.max_inputs must be an integer from 2 to 24");
  }
  return { feePayer: resolve(baseDir, feePayer), maxInputs };
}

function stringList(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
    throw new Error(`${where} must be a non-empty list of strings`);
  }
  return v as string[];
}

function parseWebhooks(raw: unknown, walletNames: ReadonlySet<string>, env: NodeJS.ProcessEnv): WebhookConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("[[webhook]] must be an array of tables");
  const hooks = raw.map((w: Record<string, unknown>, i): WebhookConfig => {
    const where = `webhook[${i}]`;
    const name = str(w, "name", where);
    if (name === undefined || !NAME.test(name)) throw new Error(`${where}.name must match ${NAME}`);
    const url = str(w, "url", where);
    if (url === undefined) throw new Error(`${where}.url is required`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}.url is not a URL`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
      throw new Error(`${where}.url must be https (http is allowed only for localhost)`);
    }
    const secretEnv = str(w, "secret_env", where);
    if (secretEnv === undefined) throw new Error(`${where}.secret_env is required`);
    const secret = env[secretEnv];
    if (secret === undefined || secret.length < 16) {
      throw new Error(`${where}: env ${secretEnv} must hold a secret of at least 16 characters`);
    }
    const wallets = stringList(w["wallets"], `${where}.wallets`);
    for (const name of wallets ?? []) {
      if (!walletNames.has(name)) throw new Error(`${where}.wallets: unknown wallet ${name}`);
    }
    const events = stringList(w["events"], `${where}.events`) as RingdEventType[] | undefined;
    for (const e of events ?? []) {
      if (!EVENT_TYPES.includes(e)) throw new Error(`${where}.events: unknown event type ${e}`);
    }
    return {
      name,
      url,
      secret,
      ...(wallets === undefined ? {} : { wallets }),
      ...(events === undefined ? {} : { events }),
    };
  });
  if (new Set(hooks.map((h) => h.name)).size !== hooks.length) throw new Error("webhook names must be unique");
  return hooks;
}

function parseDelivery(t: Record<string, unknown>): DeliveryConfig {
  const num = (key: string, fallback: number, min: number) => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !(v >= min)) throw new Error(`delivery.${key} must be a number ≥ ${min}`);
    return v;
  };
  const delivery: DeliveryConfig = {
    timeoutMs: num("timeout_secs", DEFAULT_DELIVERY.timeoutMs / 1000, 0.1) * 1000,
    maxAttempts: Math.floor(num("max_attempts", DEFAULT_DELIVERY.maxAttempts, 1)),
    retryBaseMs: num("retry_base_secs", DEFAULT_DELIVERY.retryBaseMs / 1000, 0.01) * 1000,
    retryMaxMs: num("retry_max_secs", DEFAULT_DELIVERY.retryMaxMs / 1000, 0.01) * 1000,
  };
  if (delivery.retryMaxMs < delivery.retryBaseMs) throw new Error("delivery.retry_max_secs must be ≥ retry_base_secs");
  return delivery;
}

export async function loadConfig(path: string): Promise<RingdConfig> {
  const abs = resolve(path);
  return parseConfig(await readFile(abs, "utf8"), dirname(abs));
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}
