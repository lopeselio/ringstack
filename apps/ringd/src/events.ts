/**
 * Turning wallet history rows into ringd events.
 *
 * An event's `id` is `<signature>:<index>` from the SDK's stable history row
 * id, so the same row always yields the same event; together with the wallet
 * name it is the idempotency key for storage and webhook delivery.
 */
import type { Wallet } from "@heliuslabs/zolana";
import type { PrivateTransaction } from "@heliuslabs/zolana/transaction";
import { decodeMemo } from "@ringstack/core/memo";
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

/** Memos by leaf index, for matching to received rows (whose index is the leaf index). */
function memosByLeaf(wallet: Wallet): Map<bigint, string> {
  const out = new Map<bigint, string>();
  for (const entry of wallet.utxos()) {
    const memo = decodeMemo(entry.utxo.data.memo());
    if (memo !== undefined) out.set(entry.outputContext.leafIndex, memo);
  }
  return out;
}

/** Events for history rows whose ids are not in `known`, oldest first. */
export function newEvents(
  walletName: string,
  wallet: Wallet,
  known: ReadonlySet<string>,
  options: Readonly<{ backfill: boolean; now?: Date }>,
): RingdEvent[] {
  const createdAt = (options.now ?? new Date()).toISOString();
  const rows = wallet
    .privateTransactions()
    .filter((row) => !known.has(eventId(row)))
    .sort((a, b) => (a.id.slot === b.id.slot ? Number(a.id.index - b.id.index) : a.id.slot < b.id.slot ? -1 : 1));
  if (rows.length === 0) return [];

  const memos = memosByLeaf(wallet);
  return rows.map((row): RingdEvent => {
    const memo = row.direction === "inbound" ? memos.get(row.id.index) : undefined;
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
