/**
 * Encrypted transfer memos (RingPay order ids, payroll references).
 *
 * A memo travels as an encrypted transaction **message** addressed to the
 * output it describes (helius-labs/zolana#543): the message carries the same
 * view tag as that output and is encrypted to the same recipient key under the
 * transaction's ephemeral key, at the ciphertext ordinal after the outputs.
 * Its plaintext names the output: one byte with the output's position among
 * the published slots, then the memo (`MEMO_MESSAGE_LENGTH` bytes in all), as
 * the maintainers advise, so pairing stays exact when a recipient has several
 * outputs or only some outputs have memos. Messages of `MEMO_LENGTH` bytes come
 * from before that and pair by order (the k-th output with a view tag gets the
 * k-th such message with it). Only the recipient (or anyone holding the
 * transaction key, e.g. via a receipt) can read it. Messages are bound by `external_data_hash`, which the
 * proof covers, so the onchain bytes cannot be swapped after the fact.
 *
 * Outputs stay plain (empty data), so the SDK's own transfer, withdrawal and
 * merge rails spend them. Earlier versions put the memo inside the output's
 * data instead; `legacyMemo` still reads those (see utxos.ts for spending them).
 *
 * Privacy: each message reveals that its output has a memo, and its fixed
 * width (`MEMO_MESSAGE_LENGTH`). Its view tag is the output's own, so it links nothing
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

/** A memo message's plaintext: the output's slot position, then the memo. */
export const MEMO_MESSAGE_LENGTH = 1 + MEMO_LENGTH;

/**
 * The ciphertext ordinal of message `index`: messages continue the slot
 * ordinals after every published output slot, padding included (3 real
 * outputs publish 4 slots). Writer and readers both go through this.
 */
export function messageOrdinal(publishedSlots: number, index: number): number {
  return publishedSlots + index;
}

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

/** A memo for one of `recipient`'s outputs in a transfer. */
export interface OutputMemo {
  readonly recipient: ShieldedAddress;
  /** Encoded memo, normally from `encodeMemo`. */
  readonly memo: Uint8Array;
  /**
   * Which of the recipient's outputs, in the order they were added (0 is the
   * first), when the transfer pays them more than once. By default, the first
   * one no other memo has taken.
   */
  readonly nth?: number;
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
 * listed memo, naming the slot of the recipient output it describes.
 */
export function signTransferWithMemos(
  transfer: ConfidentialTransfer,
  keypair: ShieldedKeypair,
  assets: AssetRegistry,
  memos: readonly OutputMemo[],
): SppProofInputs {
  const prepared = transfer.prepare();
  for (const m of memos) {
    if (m.memo.length !== MEMO_LENGTH) throw new RangeError(`memos are ${MEMO_LENGTH} bytes (use encodeMemo)`);
  }
  // Each memo's output, as a slot position: finalize publishes the real outputs
  // first, in this order, and appends any padding after them.
  const taken = new Set<number>();
  const choose = (m: OutputMemo, free: boolean) => {
    const theirs = prepared.outputs.flatMap((o, i) =>
      !o.isDummy() && o.ownerAddress !== undefined && sameAddress(o.ownerAddress, m.recipient) ? [i] : [],
    );
    const slot = m.nth === undefined ? theirs.find((i) => !free || !taken.has(i)) : theirs[m.nth];
    if (slot === undefined) throw new RangeError("memo recipient has no such output in this transfer");
    if (taken.has(slot)) throw new RangeError("two memos for the same output");
    taken.add(slot);
    return slot;
  };
  // Memos naming their output first, so the others take what is left.
  const slots = new Array<number>(memos.length);
  memos.forEach((m, i) => {
    if (m.nth !== undefined) slots[i] = choose(m, false);
  });
  memos.forEach((m, i) => {
    if (m.nth === undefined) slots[i] = choose(m, true);
  });

  const viewingKey = keypair.viewingKey();
  const tx = viewingKey.transactionViewingKey(prepared.firstNullifier);
  try {
    const salt = randomSalt();
    const payload = encodeConfidentialSlots(prepared.outputs, assets, tx, salt);
    if (memos.length === 0) return prepared.finalize({ txViewingPublicKey: tx.publicKey(), salt, payload });
    // `prepared.outputs` holds only the real outputs; finalize pads them up to
    // the shape, and every padded slot it publishes takes an ordinal too.
    // Compact padding is not published.
    const published = prepared.proofOutputs().filter((o) => !o.isCompact()).length;
    const messages = memos.map((m, i) => {
      const plaintext = new Uint8Array(MEMO_MESSAGE_LENGTH);
      plaintext[0] = slots[i]!;
      plaintext.set(m.memo, 1);
      return {
        viewTag: outputViewTag(m.recipient),
        data: tx.encryptSlot(m.recipient.viewingPublicKey, plaintext, salt, messageOrdinal(published, i)),
      };
    });
    const signed = prepared.finalize({ txViewingPublicKey: tx.publicKey(), salt, payload, messages });
    // Readers count the slots actually published; a different count here would
    // make every memo unreadable without any error.
    if (signed.externalData.outputs.length !== published) {
      throw new Error(`published ${signed.externalData.outputs.length} output slots, memos assumed ${published}`);
    }
    return signed;
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
 * The memo message of the earlier format (`MEMO_LENGTH` bytes, naming no slot)
 * for output `position`, with the ciphertext ordinal it was encrypted at. Those
 * pair with outputs by view tag, in order: the k-th output carrying a tag gets
 * the k-th such message carrying it.
 */
export function memoMessageFor(
  tx: MemoSource,
  position: number,
): { readonly data: Uint8Array; readonly ordinal: number; readonly index: number } | undefined {
  const tag = tx.outputSlots[position]?.viewTag;
  if (tag === undefined) return undefined;
  const k = tx.outputSlots.slice(0, position).filter((s) => sameTag(s.viewTag, tag)).length;
  const indexes = tx.messages.flatMap((m, i) =>
    sameTag(m.viewTag, tag) && m.data.length === MEMO_LENGTH ? [i] : [],
  );
  const j = indexes[k];
  return j === undefined
    ? undefined
    : { data: tx.messages[j]!.data, ordinal: messageOrdinal(tx.outputSlots.length, j), index: j };
}

/** Exactly what `encodeMemo` writes: non-empty UTF-8, then only zeros. */
function isEncodedMemo(bytes: Uint8Array): boolean {
  const end = bytes.indexOf(0);
  if (end === 0) return false;
  if (end !== -1 && bytes.subarray(end).some((b) => b !== 0)) return false;
  try {
    return decodeMemo(bytes) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Decrypt the memo for output `position` with `decrypt(ciphertext, ordinal)`,
 * which wraps whatever key the caller holds: the recipient's viewing key, a
 * receipt's transaction key, or a payment proof's shared secret. Returns the
 * raw memo bytes, or undefined when the output has no memo exactly as
 * `encodeMemo` writes it. A message naming the slot wins; one of the earlier
 * format is read only when none does.
 */
export function readMemo(
  tx: MemoSource,
  position: number,
  decrypt: (ciphertext: Uint8Array, ordinal: number) => Uint8Array,
): Uint8Array | undefined {
  const tag = tx.outputSlots[position]?.viewTag;
  if (tag === undefined) return undefined;
  for (const [j, m] of tx.messages.entries()) {
    if (m.data.length !== MEMO_MESSAGE_LENGTH || !sameTag(m.viewTag, tag)) continue;
    try {
      const bytes = decrypt(m.data, messageOrdinal(tx.outputSlots.length, j));
      const memo = bytes.slice(1);
      if (bytes[0] === position && isEncodedMemo(memo)) return memo;
    } catch {
      // Not ours, or not decryptable with this key.
    }
  }
  const message = memoMessageFor(tx, position);
  if (message === undefined || message.data.length !== MEMO_LENGTH) return undefined;
  // Only an exact encodeMemo result counts, so bytes decrypted at a wrong
  // ordinal (random) are not taken for a memo.
  const attempt = (ordinal: number) => {
    try {
      const bytes = decrypt(message.data, ordinal);
      return isEncodedMemo(bytes) ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
  const found = attempt(message.ordinal);
  if (found !== undefined) return found;
  // Before the fix in signTransferWithMemos, a padded transfer encrypted its
  // memos after the real outputs only. Shapes have 2, 4, 8 or 16 slots, so a
  // padded one held 1 real output (of 2) or more than half and fewer than all;
  // try those few starting points.
  const slots = tx.outputSlots.length;
  const fewest = slots === 2 ? 1 : Math.floor(slots / 2) + 1;
  for (let real = slots - 1; real >= fewest; real--) {
    const legacy = attempt(messageOrdinal(real, message.index));
    if (legacy !== undefined) return legacy;
  }
  return undefined;
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
