/**
 * Public pool events: the parts of a shielded-pool transaction anyone can see.
 *
 * Deposits and withdrawals move SOL in and out of the pool's SOL vault in the
 * clear. Everything else (private transfers, merges) leaves the vault alone and
 * reveals no amounts, so it is not an event here.
 *
 *   deposit     vault balance goes up; the depositor is the signer that paid it
 *   withdrawal  vault balance goes down; the recipient is the non-signer account
 *               credited with exactly that amount
 */
export type PoolEventKind = "deposit" | "withdrawal";

export interface PoolEvent {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds. */
  readonly time: number;
  readonly kind: PoolEventKind;
  /** Lamports, decimal string. */
  readonly amount: string;
  /** Depositor (deposit) or recipient (withdrawal). */
  readonly address: string;
}

/** The subset of a `getTransaction` (jsonParsed) result we read. */
export interface ParsedTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: { readonly accountKeys: readonly { readonly pubkey: string; readonly signer: boolean }[] };
  };
  readonly meta: {
    readonly err: unknown;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
  } | null;
}

/** The public event in `tx`, if it moves SOL in or out of `vault`. */
export function classify(tx: ParsedTransaction, vault: string): PoolEvent | undefined {
  const meta = tx.meta;
  if (meta === null || meta.err !== null || tx.blockTime === null) return undefined;
  const keys = tx.transaction.message.accountKeys;
  const v = keys.findIndex((k) => k.pubkey === vault);
  if (v < 0) return undefined;
  const delta = (i: number) => (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
  const vaultDelta = delta(v);
  if (vaultDelta === 0) return undefined;
  const base = { signature: tx.transaction.signatures[0]!, slot: tx.slot, time: tx.blockTime };

  if (vaultDelta > 0) {
    // The signer whose balance fell by at least the deposit (it also pays fees).
    const payer = keys.findIndex((k, i) => k.signer && -delta(i) >= vaultDelta);
    if (payer < 0) return undefined;
    return { ...base, kind: "deposit", amount: String(vaultDelta), address: keys[payer]!.pubkey };
  }
  const recipient = keys.findIndex((k, i) => !k.signer && i !== v && delta(i) === -vaultDelta);
  if (recipient < 0) return undefined;
  return { ...base, kind: "withdrawal", amount: String(-vaultDelta), address: keys[recipient]!.pubkey };
}
