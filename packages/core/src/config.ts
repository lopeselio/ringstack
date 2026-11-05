import type { ZolanaClientConfig } from "@heliuslabs/zolana";
import { SignedTeePolicy } from "@heliuslabs/zolana/client";

export type Network = "localnet" | "devnet";

/** Service endpoints for one network. Devnet serves the indexer and prover from the RPC host. */
export interface Endpoints {
  readonly rpcUrl: string;
  readonly indexerUrl?: string;
  readonly proverUrl?: string;
}

/** Ports from `zolana dev start`. */
export const LOCALNET = Object.freeze({
  rpcUrl: "http://127.0.0.1:8899",
  indexerUrl: "http://127.0.0.1:8784",
  proverUrl: "http://127.0.0.1:3001",
}) satisfies Endpoints;

/**
 * Devnet (zolana v0.8): one Helius RPC URL. The SDK serves the indexer and the
 * prover from its `/v1/spr` namespace, with the same API key.
 */
export const DEVNET = Object.freeze({ rpcUrl: "https://devnet.helius-rpc.com" }) satisfies Endpoints;

export interface ConfigInput {
  readonly network: Network;
  readonly apiKey?: string | undefined;
  readonly overrides?: Partial<Endpoints>;
}

/** Build a client config for a network preset with optional per-service overrides. */
export function clientConfig({ network, apiKey, overrides = {} }: ConfigInput): ZolanaClientConfig {
  const set = stripUndefined(overrides);

  if (network === "localnet") {
    const endpoints = { ...LOCALNET, ...set };
    return Object.freeze({
      solanaRpcUrl: endpoints.rpcUrl,
      indexerUrl: endpoints.indexerUrl,
      proverUrl: endpoints.proverUrl,
      // The v0.6.0-alpha release prover predates indexed proofs; the client supplies proof data.
      proofDataSource: "client",
    });
  }

  const rpcUrl = set.rpcUrl ?? DEVNET.rpcUrl;
  if (!apiKey && rpcUrl === DEVNET.rpcUrl) {
    throw new Error("devnet requires API_KEY (or a ZOLANA_RPC_URL that embeds one)");
  }
  return Object.freeze({
    solanaRpcUrl: apiKey ? `${rpcUrl}/?api-key=${apiKey}` : rpcUrl,
    ...(set.indexerUrl === undefined ? {} : { indexerUrl: set.indexerUrl }),
    ...(set.proverUrl === undefined ? {} : { proverUrl: set.proverUrl }),
    proofDataSource: "prover",
    // Every remote prover call is encrypted to an enclave that attests to the
    // policy Helius publishes for devnet, signed by keys the SDK pins.
    proverTee: SignedTeePolicy.forNetwork("devnet"),
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
