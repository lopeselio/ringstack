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
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ZolanaClientConfig } from "@heliuslabs/zolana";
import { clientConfig, type Network } from "@ringstack/core";
import { parse } from "smol-toml";

export interface WalletConfig {
  readonly name: string;
  readonly keyFile: string;
}

export interface RingdConfig {
  readonly network: Network;
  readonly database: string;
  readonly pollIntervalMs: number;
  readonly client: ZolanaClientConfig;
  readonly wallets: readonly WalletConfig[];
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
    return { name, keyFile: resolve(baseDir, keyFile) };
  });
  const names = new Set(wallets.map((w) => w.name));
  if (names.size !== wallets.length) throw new Error("wallet names must be unique");

  return {
    network,
    database: resolve(baseDir, str(doc, "database", "config") ?? "./ringd.db"),
    pollIntervalMs: interval * 1000,
    client: clientConfig({ network, apiKey, overrides: stripUndefined(overrides) }),
    wallets,
  };
}

export async function loadConfig(path: string): Promise<RingdConfig> {
  const abs = resolve(path);
  return parseConfig(await readFile(abs, "utf8"), dirname(abs));
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}
