/**
 * Turning wallet history rows into ringd events.
 *
 * An event's `id` is `<signature>:<index>` from the SDK's stable history row
 * id, so the same row always yields the same event; together with the wallet
 * name it is the idempotency key for storage and webhook delivery.
 */
import { ViewingKey, type Wallet } from "@heliuslabs/zolana";
import { bytes32 } from "@heliuslabs/zolana/keypair";
import type { PrivateTransaction } from "@heliuslabs/zolana/transaction";
import { decodeMemo, receivedMemos } from "@ringstack/core/memo";
import { fetchShieldedTransaction, type ShieldedTransactionReader } from "@ringstack/core/receipt-open";
import type { WatchKeys } from "@ringstack/core";
import type { Signature } from "@solana/kit";
import type { RingdEvent, RingdEventType } from "@ringstack/ringd-client";

export type { RingdEvent, RingdEventType } from "@ringstack/ringd-client";

export function eventType(row: Pick<PrivateTransaction, "kind" | "direction">): RingdEventType {
  if (row.kind === "merge") return "utxo.merged";
  if (row.direction === "inbound") return "payment.received";
  if (row.direction === "outbound") return "payment.sent";
  return "wallet.activity";
}

export function eventId(row: Pick<PrivateTransaction, "id">): string {
  return `${row.id.signature}:${row.id.index}`;
}

/** Legacy memos (inside outputs) by leaf index, for matching to received rows (whose index is the leaf index). */
function memosByLeaf(wallet: Wallet): Map<bigint, string> {
  const out = new Map<bigint, string>();
  for (const entry of wallet.utxos()) {
    const memo = decodeMemo(entry.utxo.data.memo());
    if (memo !== undefined) out.set(entry.outputContext.leafIndex, memo);
  }
  return out;
}

function pendingRows(wallet: Wallet, known: ReadonlySet<string>) {
  return wallet
    .privateTransactions()
    .filter((row) => !known.has(eventId(row)))
    .sort((a, b) => (a.id.slot === b.id.slot ? Number(a.id.index - b.id.index) : a.id.slot < b.id.slot ? -1 : 1));
}

/**
 * Memo messages for the received rows not yet in `known`, keyed by event id.
 * Memos travel as encrypted transaction messages (see @ringstack/core/memo),
 * which the wallet sync does not keep, so each new payment's transaction is
 * fetched once and its messages decrypted with the watched viewing key.
 * Throws if a transaction cannot be fetched, so the cycle retries rather than
 * emit a payment without its order memo.
 */
export async function messageMemos(
  client: ShieldedTransactionReader,
  wallet: Wallet,
  keys: WatchKeys,
  known: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const signatures = new Set(
    pendingRows(wallet, known)
      .filter((row) => row.direction === "inbound")
      .map((row) => row.id.signature),
  );
  const out = new Map<string, string>();
  if (signatures.size === 0) return out;
  const viewingKey = ViewingKey.fromBytes(bytes32(keys.viewingSecret.slice()));
  try {
    for (const signature of signatures) {
      const tx = await fetchShieldedTransaction(client, signature as Signature);
      for (const [leaf, memo] of receivedMemos(tx, keys.address, viewingKey)) out.set(`${signature}:${leaf}`, memo);
    }
  } finally {
    viewingKey.destroy();
  }
  return out;
}

/** Events for history rows whose ids are not in `known`, oldest first. */
export function newEvents(
  walletName: string,
  wallet: Wallet,
  known: ReadonlySet<string>,
  options: Readonly<{ backfill: boolean; now?: Date; messageMemos?: ReadonlyMap<string, string> }>,
): RingdEvent[] {
  const createdAt = (options.now ?? new Date()).toISOString();
  const rows = pendingRows(wallet, known);
  if (rows.length === 0) return [];

  const memos = memosByLeaf(wallet);
  return rows.map((row): RingdEvent => {
    const memo =
      row.direction === "inbound"
        ? (options.messageMemos?.get(eventId(row)) ?? memos.get(row.id.index))
        : undefined;
    const counterparty = row.counterpartyViewingPublicKey?.toBytes();
    return {
      id: eventId(row),
      type: eventType(row),
      wallet: walletName,
      signature: row.id.signature,
      slot: row.id.slot.toString(),
      kind: row.kind,
      direction: row.direction,
      asset: row.asset,
      amount: row.amount.toString(),
      ...(memo === undefined ? {} : { memo }),
      ...(counterparty === undefined ? {} : { counterpartyViewingKey: Buffer.from(counterparty).toString("hex") }),
      backfill: options.backfill,
      createdAt,
    };
  });
}
