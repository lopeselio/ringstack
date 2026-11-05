import { readFileSync } from "node:fs";

import type { ZolanaClientConfig } from "@heliuslabs/zolana";
import { teePolicyFromJson } from "@heliuslabs/zolana/client";

export type Network = "localnet" | "devnet";

/** Service endpoints for one network. */
export interface Endpoints {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
}

/** Ports from `zolana dev start`. */
export const LOCALNET: Endpoints = Object.freeze({
  rpcUrl: "http://127.0.0.1:8899",
  indexerUrl: "http://127.0.0.1:8784",
  proverUrl: "http://127.0.0.1:3001",
});

/**
 * Devnet services as used by helius-labs/zolana-examples for v0.6.0-alpha.
 * Helius plans to serve all three from one RPC URL; until then they are separate.
 */
export const DEVNET: Endpoints = Object.freeze({
  rpcUrl: "https://devnet.helius-rpc.com",
  indexerUrl: "https://d34xe1hqb2ibg2.cloudfront.net",
  proverUrl: "https://dd73hh473h6ha.cloudfront.net",
});

/** Pinned Nitro enclave measurements for the devnet prover (Devnet-e, v0.6.0-alpha). */
export function devnetTeePolicy() {
  const raw = readFileSync(new URL("./devnet-e-tee-policy.json", import.meta.url), "utf8");
  return teePolicyFromJson(JSON.parse(raw));
}

export interface ConfigInput {
  readonly network: Network;
  readonly apiKey?: string | undefined;
  readonly overrides?: Partial<Endpoints>;
}

/** Build a client config for a network preset with optional per-service overrides. */
export function clientConfig({ network, apiKey, overrides = {} }: ConfigInput): ZolanaClientConfig {
  const base = network === "devnet" ? DEVNET : LOCALNET;
  const endpoints = { ...base, ...stripUndefined(overrides) };

  if (network === "localnet") {
    return Object.freeze({
      solanaRpcUrl: endpoints.rpcUrl,
      indexerUrl: endpoints.indexerUrl,
      proverUrl: endpoints.proverUrl,
      // The pinned release prover predates indexed proofs; the client supplies proof data.
      proofDataSource: "client",
    });
  }

  if (!apiKey && endpoints.rpcUrl === DEVNET.rpcUrl) {
    throw new Error("devnet requires API_KEY (or a ZOLANA_RPC_URL that embeds one)");
  }
  const solanaRpcUrl = apiKey ? `${endpoints.rpcUrl}/?api-key=${apiKey}` : endpoints.rpcUrl;
  const usesPinnedProver = endpoints.proverUrl.replace(/\/$/, "") === DEVNET.proverUrl;

  return Object.freeze({
    solanaRpcUrl,
    indexerUrl: endpoints.indexerUrl,
    proverUrl: endpoints.proverUrl,
    proofDataSource: "prover",
    ...(usesPinnedProver ? { proverTee: devnetTeePolicy() } : {}),
  });
}

/** ZOLANA_NETWORK, defaulting to localnet. */
export function networkFromEnv(env: NodeJS.ProcessEnv = process.env): Network {
  const network = (env["ZOLANA_NETWORK"]?.trim() || "localnet") as Network;
  if (network !== "localnet" && network !== "devnet") {
    throw new Error(`ZOLANA_NETWORK must be localnet or devnet, got ${network}`);
  }
  return network;
}

/** Read the config from ZOLANA_* environment variables (see .env.example). */
export function clientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZolanaClientConfig {
  const network = networkFromEnv(env);
  return clientConfig({
    network,
    apiKey: env["API_KEY"]?.trim() || undefined,
    overrides: {
      rpcUrl: env["ZOLANA_RPC_URL"]?.trim() || undefined,
      indexerUrl: env["ZOLANA_INDEXER_URL"]?.trim() || undefined,
      proverUrl: env["ZOLANA_PROVER_URL"]?.trim() || undefined,
    } as Partial<Endpoints>,
  });
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
