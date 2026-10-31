/**
 * Encrypted transfer memos (RingPay order ids, payroll references).
 *
 * A memo is a `Data` record inside each output's confidential plaintext: only
 * the output's owner (and anyone holding the transaction key, e.g. via a
 * receipt) can read it. It is not part of the UTXO commitment, but the
 * ciphertext is bound by `external_data_hash`, which the proof covers.
 *
 * `ConfidentialTransfer#send` takes no memo, so `signTransferWithMemos`
 * re-encrypts the prepared outputs with memos attached. Memos do not change
 * the commitments, so the prepared transfer finalizes unchanged.
 *
 * Privacy: a memo makes its slot's ciphertext longer. Memos are fixed-width
 * and every real output gets one (zero-filled if the caller set none), so
 * real slots stay the same length as each other. Random padding slots
 * (`ConfidentialTransfer` with fewer outputs than the shape) are still sized
 * for an empty plaintext and remain distinguishable.
 */
import type { ShieldedAddress, ShieldedKeypair } from "@heliuslabs/zolana";
import { randomSalt } from "@heliuslabs/zolana/keypair";
import {
  encodeConfidentialSlots,
  type AssetRegistry,
  type ConfidentialTransfer,
  type SppProofInputs,
} from "@heliuslabs/zolana/transaction";

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

/**
 * Like `transfer.sign(keypair, assets)`, but each output owned by a listed
 * recipient carries that memo. Every other real output (change included)
 * carries a zero memo of the same width.
 */
export function signTransferWithMemos(
  transfer: ConfidentialTransfer,
  keypair: ShieldedKeypair,
  assets: AssetRegistry,
  memos: readonly OutputMemo[],
): SppProofInputs {
  const width = memos[0]?.memo.length ?? MEMO_LENGTH;
  if (memos.some((m) => m.memo.length !== width)) {
    throw new RangeError("all memos must have the same length");
  }

  const prepared = transfer.prepare();
  const outputs = prepared.outputs.map((output) => {
    const owner = output.ownerAddress;
    if (output.isDummy() || owner === undefined) return output;
    const memo = memos.find((m) => sameAddress(m.recipient, owner))?.memo ?? new Uint8Array(width);
    return output.withMemo(memo);
  });
  const owners = prepared.outputs.flatMap((o) => (o.isDummy() || o.ownerAddress === undefined ? [] : [o.ownerAddress]));
  if (memos.some((m) => !owners.some((owner) => sameAddress(m.recipient, owner)))) {
    throw new RangeError("memo recipient has no output in this transfer");
  }

  const viewingKey = keypair.viewingKey();
  const tx = viewingKey.transactionViewingKey(prepared.firstNullifier);
  try {
    const salt = randomSalt();
    return prepared.finalize({
      txViewingPublicKey: tx.publicKey(),
      salt,
      payload: encodeConfidentialSlots(outputs, assets, tx, salt),
    });
  } finally {
    tx.destroy();
    viewingKey.destroy();
  }
}
