/**
 * Wallet UTXO helpers shared by RingSession, merges and payroll.
 *
 * "Spendable" here means spendable through the lower-level builders: no
 * committed data, no ring binding, and data that is at most a memo. The SDK's
 * own selection is stricter (`isPlainUtxo` rejects memos; see
 * helius-labs/zolana#543).
 */
import { MERGE_INPUT_COUNT } from "@heliuslabs/zolana/interface";
import { Utxo } from "@heliuslabs/zolana/transaction";
import type { Address, Wallet } from "@heliuslabs/zolana";

export type WalletEntry = ReturnType<Wallet["utxos"]>[number];

/** Stable key of a wallet UTXO (its commitment hash), for tracking which inputs are taken. */
export function utxoKey(entry: WalletEntry): string {
  return Buffer.from(entry.outputContext.hash).toString("hex");
}

/** Unspent UTXOs of `asset` that the lower-level builder can spend (plain or memo-only), largest first. */
export function spendableUtxos(wallet: Wallet, asset: Address): WalletEntry[] {
  return wallet
    .utxos()
    .filter((e) => isSpendable(e, asset))
    .sort((a, b) => (a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount > b.utxo.amount ? -1 : 1));
}

/** Spendable by the lower-level builder: no committed data, no ring, and data that is at most a memo. */
export function isSpendable(e: WalletEntry, asset: Address): boolean {
  return (
    !e.spent &&
    e.utxo.asset === asset &&
    e.utxo.ringProgramId === undefined &&
    e.dataHash === undefined &&
    e.ringDataHash === undefined &&
    e.utxo.data.records().every((r) => r.kind === "memo")
  );
}

/** Whether the wallet holds memo-bearing UTXOs of `asset` (skipped by the SDK's default selection). */
export function hasMemoUtxos(wallet: Wallet, asset: Address): boolean {
  return wallet.utxos().some((e) => isSpendable(e, asset) && !e.utxo.data.isEmpty());
}

/** The same UTXO without its memo: identical commitment, since the memo is not hashed. */
export function withoutMemo(utxo: Utxo): Utxo {
  const rest = utxo.data.records().filter((r) => r.kind !== "memo");
  if (rest.length > 0) throw new Error("UTXO carries data other than a memo");
  return new Utxo({
    owner: utxo.owner,
    asset: utxo.asset,
    amount: utxo.amount,
    blinding: utxo.blinding,
    ...(utxo.ringProgramId === undefined ? {} : { ringProgramId: utxo.ringProgramId }),
  });
}

/** Up to `maxInputs` (default `MERGE_INPUT_COUNT`) spendable UTXOs (memo-only included), smallest first. */
export function mergeEntries(wallet: Wallet, asset: Address, maxInputs: number = MERGE_INPUT_COUNT): WalletEntry[] {
  const entries = wallet
    .utxos()
    .filter((e) => isSpendable(e, asset))
    .sort((a, b) => (a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount < b.utxo.amount ? -1 : 1))
    .slice(0, maxInputs);
  if (entries.length < 2) throw new Error("nothing to merge: fewer than 2 spendable UTXOs");
  return entries;
}

