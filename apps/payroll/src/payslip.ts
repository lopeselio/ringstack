/**
 * The payee's side: list incoming payments, prove one, check a proof.
 * See spec/payment-proof.md.
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { resolveRegisteredAddress } from "@heliuslabs/spr/wallet";
import {
  decodePaymentProof,
  encodePaymentProof,
  fetchShieldedTransaction,
  provePayment,
  verifyPaymentProof,
  type RingSession,
  type VerifiedPayment,
  type SprClient,
} from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";
import type { Address, Signature } from "@solana/kit";

export interface Payslip {
  readonly signature: string;
  readonly slot: string;
  readonly asset: string;
  readonly amount: string;
  readonly memo?: string;
}

/**
 * Incoming payments from the payee's synced wallet, newest first. Memos travel
 * as transaction messages, so each payment's transaction is fetched once.
 */
export async function listPayslips(session: RingSession): Promise<Payslip[]> {
  const rows = session.wallet
    .privateTransactions()
    .filter((row) => row.direction === "inbound" && row.kind === "privateTransfer")
    .sort((a, b) => (a.id.slot === b.id.slot ? 0 : a.id.slot > b.id.slot ? -1 : 1));
  const memos = new Map<string, Map<bigint, string>>();
  for (const signature of new Set(rows.map((row) => row.id.signature))) {
    memos.set(signature, await session.receivedMemos(signature as Signature));
  }
  return rows.map((row) => {
    const memo = memos.get(row.id.signature)?.get(row.id.index);
    return {
      signature: row.id.signature,
      slot: row.id.slot.toString(),
      asset: row.asset,
      amount: row.amount.toString(),
      ...(memo === undefined ? {} : { memo }),
    };
  });
}

/** A `ringproof1:` link for the payee's output in `signature`. */
export async function provePayslip(
  session: RingSession,
  signature: Signature,
  cluster: Cluster,
  outputSlot?: number,
): Promise<string> {
  const tx = await fetchShieldedTransaction(session.client, signature);
  const proof = provePayment(session.keypair, tx, cluster, {
    assets: session.wallet.registry,
    ...(outputSlot === undefined ? {} : { outputSlot }),
  });
  return encodePaymentProof(proof);
}

export interface CheckedProof extends VerifiedPayment {
  readonly cluster: Cluster;
  /** Whether the payee's current registry record carries the proof's viewing key. */
  readonly registered: boolean;
  /** The Solana account that paid the transaction fee, when the RPC can tell. */
  readonly feePayer?: Address;
}

/** Everything a landlord, bank or accountant runs: no keys, just the link and the network. */
export async function checkProof(client: SprClient, link: string): Promise<CheckedProof> {
  const proof = decodePaymentProof(link);
  const tx = await fetchShieldedTransaction(client, proof.signature);
  const verified = verifyPaymentProof(proof, tx);
  const record = await resolveRegisteredAddress({ rpc: client, owner: verified.owner }).catch(() => undefined);
  const registered =
    record !== undefined &&
    record.address.viewingPublicKey.toBytes().every((b, i) => b === proof.recipient.viewingPublicKey.toBytes()[i]);
  let feePayer: Address | undefined;
  try {
    const res = await client.solanaRpc
      .getTransaction(proof.signature, { encoding: "json", maxSupportedTransactionVersion: 0 })
      .send();
    feePayer = res?.transaction.message.accountKeys[0] as Address | undefined;
  } catch {
    feePayer = undefined;
  }
  return { ...verified, cluster: proof.cluster, registered, ...(feePayer === undefined ? {} : { feePayer }) };
}

export function formatAmount(amount: bigint, mint: string): string {
  if (mint !== SOL_MINT) return `${amount} base units of ${mint}`;
  const s = amount.toString().padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "") + " SOL";
}
