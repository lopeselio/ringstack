/**
 * Encrypted transfer memos (RingPay order ids, payroll references).
 *
 * A memo travels as an encrypted transaction **message** addressed to the
 * output it describes (helius-labs/zolana#543): the message carries the same
 * view tag as that output and is encrypted to the same recipient key under the
 * transaction's ephemeral key, at the ciphertext ordinal after the outputs.
 * Only the recipient (or anyone holding the transaction key, e.g. via a
 * receipt) can read it. Messages are bound by `external_data_hash`, which the
 * proof covers, so the onchain bytes cannot be swapped after the fact.
 *
 * Outputs stay plain (empty data), so the SDK's own transfer, withdrawal and
 * merge rails spend them. Earlier versions put the memo inside the output's
 * data instead; `legacyMemo` still reads those (see utxos.ts for spending them).
 *
 * Privacy: each message reveals that its output has a memo, and its fixed
 * width (`MEMO_LENGTH`). Its view tag is the output's own, so it links nothing
 * an observer could not already link.
 */
import type { ShieldedAddress, ShieldedKeypair, ViewingKey } from "@heliuslabs/spr";
import { randomSalt } from "@heliuslabs/spr/keypair";
import {
  encodeConfidentialSlots,
  type AssetRegistry,
  type ConfidentialTransfer,
  type IndexedShieldedTransaction,
  type SppProofInputs,
} from "@heliuslabs/spr/transaction";

/** Fixed memo width in bytes. */
export const MEMO_LENGTH = 32;

/** UTF-8 encode and zero-pad `text` to `MEMO_LENGTH`. */
export function encodeMemo(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MEMO_LENGTH) {
    throw new RangeError(`memo is ${bytes.length} bytes, max ${MEMO_LENGTH}`);
  }
  if (bytes.includes(0)) throw new RangeError("memo must not contain NUL");
  const out = new Uint8Array(MEMO_LENGTH);
  out.set(bytes);
  return out;
}

/** Inverse of `encodeMemo`. Returns undefined for an absent or all-zero memo. */
export function decodeMemo(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const end = bytes.indexOf(0);
  const text = bytes.subarray(0, end === -1 ? bytes.length : end);
  if (text.length === 0) return undefined;
  return new TextDecoder("utf-8", { fatal: true }).decode(text);
}

export interface OutputMemo {
  readonly recipient: ShieldedAddress;
  /** Encoded memo, normally from `encodeMemo`. */
  readonly memo: Uint8Array;
}

function sameAddress(a: ShieldedAddress, b: ShieldedAddress): boolean {
  const x = a.viewingPublicKey.toBytes();
  const y = b.viewingPublicKey.toBytes();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The view tag the SDK puts on outputs to `address` (and that its memo message reuses). */
export function outputViewTag(address: ShieldedAddress) {
  return address.signingPublicKey.confidentialViewTag();
}

/**
 * Like `transfer.sign(keypair, assets)`, plus one encrypted memo message per
 * listed recipient, addressed to that recipient's output.
 */
export function signTransferWithMemos(
  transfer: ConfidentialTransfer,
  keypair: ShieldedKeypair,
  assets: AssetRegistry,
  memos: readonly OutputMemo[],
): SppProofInputs {
  const prepared = transfer.prepare();
  const owners = prepared.outputs.flatMap((o) => (o.isDummy() || o.ownerAddress === undefined ? [] : [o.ownerAddress]));
  if (memos.some((m) => !owners.some((owner) => sameAddress(m.recipient, owner)))) {
    throw new RangeError("memo recipient has no output in this transfer");
  }
  for (const m of memos) {
    if (m.memo.length !== MEMO_LENGTH) throw new RangeError(`memos are ${MEMO_LENGTH} bytes (use encodeMemo)`);
  }

  const viewingKey = keypair.viewingKey();
  const tx = viewingKey.transactionViewingKey(prepared.firstNullifier);
  try {
    const salt = randomSalt();
    const payload = encodeConfidentialSlots(prepared.outputs, assets, tx, salt);
    // Message ciphertexts continue the slot ordinals after every published
    // output slot. `prepared.outputs` holds only the real outputs; finalize pads
    // them up to the shape (3 real outputs publish 4 slots), and each padded
    // slot takes an ordinal too. Compact padding is not published.
    const published = prepared.proofOutputs().filter((o) => !o.isCompact()).length;
    const messages = memos.map((m, i) => ({
      viewTag: outputViewTag(m.recipient),
      data: tx.encryptSlot(m.recipient.viewingPublicKey, m.memo, salt, published + i),
    }));
    return prepared.finalize({
      txViewingPublicKey: tx.publicKey(),
      salt,
      payload,
      ...(messages.length === 0 ? {} : { messages }),
    });
  } finally {
    tx.destroy();
    viewingKey.destroy();
  }
}

// --- reading -----------------------------------------------------------------

/** The parts of an indexed transaction a memo reader needs. */
export interface MemoSource {
  readonly outputSlots: readonly { readonly viewTag: Uint8Array }[];
  readonly messages: readonly { readonly viewTag: Uint8Array; readonly data: Uint8Array }[];
}

const sameTag = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The memo message addressed to output `position`, with the ciphertext ordinal
 * it was encrypted at. Messages pair with outputs by view tag, in order: the
 * k-th output carrying a tag gets the k-th message carrying it.
 */
export function memoMessageFor(
  tx: MemoSource,
  position: number,
): { readonly data: Uint8Array; readonly ordinal: number } | undefined {
  const tag = tx.outputSlots[position]?.viewTag;
  if (tag === undefined) return undefined;
  const k = tx.outputSlots.slice(0, position).filter((s) => sameTag(s.viewTag, tag)).length;
  const indexes = tx.messages.flatMap((m, i) => (sameTag(m.viewTag, tag) ? [i] : []));
  const j = indexes[k];
  return j === undefined ? undefined : { data: tx.messages[j]!.data, ordinal: tx.outputSlots.length + j };
}

/**
 * Decrypt the memo for output `position` with `decrypt(ciphertext, ordinal)`,
 * which wraps whatever key the caller holds: the recipient's viewing key, a
 * receipt's transaction key, or a payment proof's shared secret. Returns the
 * raw memo bytes, or undefined when the output has no well-formed memo.
 */
export function readMemo(
  tx: MemoSource,
  position: number,
  decrypt: (ciphertext: Uint8Array, ordinal: number) => Uint8Array,
): Uint8Array | undefined {
  const message = memoMessageFor(tx, position);
  if (message === undefined || message.data.length !== MEMO_LENGTH) return undefined;
  try {
    const bytes = decrypt(message.data, message.ordinal);
    return decodeMemo(bytes) === undefined ? undefined : bytes;
  } catch {
    return undefined;
  }
}

/**
 * Memos addressed to `address` in `tx`, keyed by the leaf index of the output
 * they describe (the index wallet history rows use for received outputs).
 */
export function receivedMemos(
  tx: IndexedShieldedTransaction,
  address: ShieldedAddress,
  viewingKey: ViewingKey,
): Map<bigint, string> {
  const out = new Map<bigint, string>();
  const { txViewingPublicKey, salt } = tx;
  if (txViewingPublicKey === undefined || salt === undefined || tx.messages.length === 0) return out;
  const tag = outputViewTag(address);
  tx.outputSlots.forEach((slot, position) => {
    if (!sameTag(slot.viewTag, tag)) return;
    const memo = decodeMemo(
      readMemo(tx, position, (data, ordinal) => viewingKey.decryptUtxo(data, txViewingPublicKey, salt, ordinal)),
    );
    if (memo !== undefined) out.set(slot.outputContext.leafIndex, memo);
  });
  return out;
}
