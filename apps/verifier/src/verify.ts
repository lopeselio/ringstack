/**
 * Receipt verification for the browser: decode → fetch → decrypt → look up
 * each output's owner in the user registry → re-open with those addresses so
 * their commitments are recomputed. See spec/receipt.md.
 */
import {
  SOL_MINT,
  ShieldedKeypair,
  Wallet,
  createZolanaClient,
  fetchAssetMetadata,
  fetchViewingKeyOwners,
  formatAmount,
  viewingKeyIndex,
  type Address,
  type ShieldedAddress,
} from "@heliuslabs/zolana";
import { backfillAssetRegistry, resolveRegisteredAddress } from "@heliuslabs/zolana/wallet";
import { decodeReceipt, type Cluster, type Receipt } from "@ringstack/core/receipt";
import {
  fetchShieldedTransaction,
  openReceipt,
  type CommitmentCheck,
  type OpenedReceipt,
} from "@ringstack/core/receipt-open";
import { decodeMemo } from "@ringstack/core/memo";
import {
  PaymentProofError,
  decodePaymentProof,
  verifyPaymentProof,
  type VerifiedPayment,
} from "@ringstack/core/payment-proof";

export interface Endpoints {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
}

const DEFAULT_ENDPOINTS: Partial<Record<Cluster, Endpoints>> = {
  localnet: { rpcUrl: "http://127.0.0.1:8899", indexerUrl: "http://127.0.0.1:8784" },
  devnet: { rpcUrl: "https://api.devnet.solana.com", indexerUrl: "https://d34xe1hqb2ibg2.cloudfront.net" },
};

/** `?rpc=` and `?indexer=` override the cluster defaults. */
export function endpointsFor(cluster: Cluster, params: URLSearchParams): Endpoints {
  const base = DEFAULT_ENDPOINTS[cluster];
  const rpcUrl = params.get("rpc") ?? base?.rpcUrl;
  const indexerUrl = params.get("indexer") ?? base?.indexerUrl;
  if (rpcUrl === undefined || indexerUrl === undefined) {
    throw new VerifyError(`Receipts for ${cluster} can't be checked yet. Helius Privacy runs on devnet only.`);
  }
  return { rpcUrl, indexerUrl };
}

export class VerifyError extends Error {
  override name = "VerifyError";
}

export interface VerifiedOutput {
  readonly slot: number;
  /** Registered Solana owner of the recipient's viewing key, when the registry has one. */
  readonly owner?: Address;
  /** Hex of the recipient's compressed viewing key, for unregistered recipients. */
  readonly viewingKey: string;
  readonly mint?: Address;
  readonly assetId: bigint;
  /** Amount formatted with the mint's decimals; raw units when they are unknown. */
  readonly amount: string;
  readonly symbol: string;
  readonly memo?: string;
  readonly commitment: CommitmentCheck;
}

export interface VerifyResult {
  readonly receipt: Receipt;
  readonly endpoints: Endpoints;
  readonly slot: bigint;
  readonly outputs: readonly VerifiedOutput[];
  /** Set when the registry could not be read; outputs then stay unchecked unless owners were given. */
  readonly registryError?: string;
}

export async function verifyReceipt(
  link: string,
  options: Readonly<{ params?: URLSearchParams; owners?: readonly Address[] }> = {},
): Promise<VerifyResult> {
  let receipt: Receipt;
  try {
    receipt = decodeReceipt(link.trim());
  } catch (e) {
    throw new VerifyError(`This isn't a valid receipt link: ${(e as Error).message}.`);
  }
  const endpoints = endpointsFor(receipt.cluster, options.params ?? new URLSearchParams());
  const client = await createZolanaClient({ solanaRpcUrl: endpoints.rpcUrl, indexerUrl: endpoints.indexerUrl });

  let tx;
  try {
    tx = await fetchShieldedTransaction(client, receipt.signature);
  } catch (e) {
    throw new VerifyError(
      `Couldn't load the transaction from the indexer at ${endpoints.indexerUrl}: ${(e as Error).message}`,
    );
  }

  // First pass: decrypt only, to learn each output's recipient key.
  let opened: OpenedReceipt;
  try {
    opened = openReceipt(receipt, tx);
  } catch (e) {
    throw new VerifyError(`The receipt doesn't open this transaction: ${(e as Error).message}`);
  }

  // Owners: registry reverse lookup by viewing key, plus any the reader typed in.
  const ownerByKey = new Map<string, Address>();
  let registryError: string | undefined;
  try {
    const all = await fetchViewingKeyOwners({ rpc: client });
    for (const o of opened.outputs) {
      const owner = all.get(viewingKeyIndex(o.recipientViewingKey));
      if (owner !== undefined) ownerByKey.set(viewingKeyIndex(o.recipientViewingKey), owner);
    }
  } catch (e) {
    registryError = (e as Error).message;
  }

  const known: ShieldedAddress[] = [];
  const candidates = new Set<Address>([...ownerByKey.values(), ...(options.owners ?? [])]);
  for (const owner of candidates) {
    const resolved = await resolveRegisteredAddress({ rpc: client, owner }).catch(() => undefined);
    if (resolved === undefined) continue;
    known.push(resolved.address);
    ownerByKey.set(viewingKeyIndex(resolved.address.viewingPublicKey), owner);
  }

  // SPL assets: load the onchain asset-id registry only when needed.
  const scratch = new Wallet({ identity: ShieldedKeypair.generate().shieldedAddress() });
  if (opened.outputs.some((o) => o.mint === undefined)) {
    await backfillAssetRegistry(scratch, client).catch(() => 0);
  }

  // Second pass: recompute commitments for every output with a known address.
  opened = openReceipt(receipt, tx, { knownAddresses: known, assets: scratch.registry });

  const outputs = await Promise.all(
    opened.outputs.map(async (o): Promise<VerifiedOutput> => {
      const viewingKey = viewingKeyIndex(o.recipientViewingKey);
      const owner = ownerByKey.get(viewingKey);
      const memo = decodeMemo(o.memo);
      const { amount, symbol } = await formatOutput(client, o.mint, o.amount);
      return {
        slot: o.slot,
        viewingKey,
        ...(owner === undefined ? {} : { owner }),
        ...(o.mint === undefined ? {} : { mint: o.mint }),
        assetId: o.assetId,
        amount,
        symbol,
        ...(memo === undefined ? {} : { memo }),
        commitment: o.commitment,
      };
    }),
  );

  return {
    receipt,
    endpoints,
    slot: opened.slot,
    outputs,
    ...(registryError === undefined ? {} : { registryError }),
  };
}

async function formatOutput(
  client: Parameters<typeof fetchAssetMetadata>[0],
  mint: Address | undefined,
  amount: bigint,
): Promise<{ amount: string; symbol: string }> {
  if (mint === SOL_MINT) return { amount: formatAmount(amount, 9), symbol: "SOL" };
  if (mint === undefined) return { amount: amount.toString(), symbol: "units" };
  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  try {
    const { decimals } = await fetchAssetMetadata(client, mint);
    return { amount: formatAmount(amount, decimals), symbol: short };
  } catch {
    return { amount: amount.toString(), symbol: `${short} units` };
  }
}

// --- payment proofs (ringproof1:) ---------------------------------------------

export interface VerifiedProof {
  readonly cluster: Cluster;
  readonly endpoints: Endpoints;
  readonly signature: string;
  readonly slot: bigint;
  readonly outputSlot: number;
  readonly owner: Address;
  /** The payee's current registry record carries the proof's viewing key. */
  readonly registered: boolean;
  readonly amount: string;
  readonly symbol: string;
  readonly memo?: string;
}

/** Verify a payee's proof of one output (spec/payment-proof.md). */
export async function verifyProofLink(
  link: string,
  options: Readonly<{ params?: URLSearchParams }> = {},
): Promise<VerifiedProof> {
  let proof;
  try {
    proof = decodePaymentProof(link.trim());
  } catch (e) {
    throw new VerifyError(`This isn't a valid payment proof: ${(e as Error).message}.`);
  }
  const endpoints = endpointsFor(proof.cluster, options.params ?? new URLSearchParams());
  const client = await createZolanaClient({ solanaRpcUrl: endpoints.rpcUrl, indexerUrl: endpoints.indexerUrl });
  let tx;
  try {
    tx = await fetchShieldedTransaction(client, proof.signature);
  } catch (e) {
    throw new VerifyError(`Couldn't load the transaction from the indexer at ${endpoints.indexerUrl}: ${(e as Error).message}`);
  }

  let verified: VerifiedPayment;
  try {
    try {
      verified = verifyPaymentProof(proof, tx);
    } catch (e) {
      if (!(e instanceof PaymentProofError && e.code === "UNKNOWN_ASSET")) throw e;
      const scratch = new Wallet({ identity: ShieldedKeypair.generate().shieldedAddress() });
      await backfillAssetRegistry(scratch, client);
      verified = verifyPaymentProof(proof, tx, { assets: scratch.registry });
    }
  } catch (e) {
    throw new VerifyError(
      e instanceof PaymentProofError && e.code === "COMMITMENT_MISMATCH"
        ? "This proof doesn't match the chain. Don't accept it."
        : `This proof doesn't check out: ${(e as Error).message}`,
    );
  }

  const record = await resolveRegisteredAddress({ rpc: client, owner: verified.owner }).catch(() => undefined);
  const mine = proof.recipient.viewingPublicKey.toBytes();
  const registered = record !== undefined && record.address.viewingPublicKey.toBytes().every((b, i) => b === mine[i]);
  const { amount, symbol } = await formatOutput(client, verified.mint, verified.amount);
  const memo = decodeMemo(verified.memo);
  return {
    cluster: proof.cluster,
    endpoints,
    signature: verified.signature,
    slot: verified.slot,
    outputSlot: verified.outputSlot,
    owner: verified.owner,
    registered,
    amount,
    symbol,
    ...(memo === undefined ? {} : { memo }),
  };
}
