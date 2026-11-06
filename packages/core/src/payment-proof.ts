/**
 * Payee-side payment proofs: the recipient of one output proves "I received
 * this amount of this asset, with this memo, in this transaction" without
 * revealing any other output of the transaction (spec/payment-proof.md).
 *
 * The proof discloses the X25519 shared secret between the payee's viewing key
 * and the transaction's ephemeral key. With it, a verifier decrypts exactly the
 * payee's slot and recomputes the payee's UTXO commitment from the decrypted
 * opening; a match proves the amount and asset. The same secret opens the
 * memo message addressed to that output (see memo.ts), whose ciphertext the
 * transaction's proof binds onchain. Other slots are encrypted to other
 * recipients' keys, and every transaction has a fresh ephemeral key, so the
 * secret opens nothing else.
 *
 * The slot cipher (HKDF-SHA256 → AES-CTR) is reimplemented here because the SDK
 * does not export it; `provePayment` cross-checks it against the SDK's own
 * `ViewingKey.decryptUtxo` so a protocol change fails loudly.
 *
 * Wire format (base64url, prefixed `ringproof1:`):
 *   u8  version (=1)
 *   u8  cluster (0 localnet, 1 devnet, 2 mainnet)
 *   64  transaction signature
 *   u16 output slot, little-endian
 *   32  shared secret
 *   99  payee shielded address
 */
import { ctr } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ShieldedAddress, type ViewingKey } from "@heliuslabs/spr";
import { DEFAULT_TREE_ID } from "@heliuslabs/spr/interface";
import type { X25519PublicKey } from "@heliuslabs/spr/keypair";
import {
  AssetRegistry,
  EncryptedScheme,
  Utxo,
  decodeConfidential,
  decodeOutputData,
  slotOrdinal,
  type IndexedShieldedTransaction,
} from "@heliuslabs/spr/transaction";
import { getAddressDecoder, getBase58Decoder, getBase58Encoder, type Address, type Signature } from "@solana/kit";

import { fromBase64Url, toBase64Url } from "./base64url.ts";
import { readMemo } from "./memo.ts";
import type { Cluster } from "./receipt.ts";

export const PAYMENT_PROOF_PREFIX = "ringproof1:";
const VERSION = 1;
const CLUSTERS: readonly Cluster[] = ["localnet", "devnet", "mainnet"];
const KEY_LEN = 33; // compressed X25519 key embedded at the front of each confidential slot
const ADDRESS_LEN = 99;
const BODY_LEN = 1 + 1 + 64 + 2 + 32 + ADDRESS_LEN;

export class PaymentProofError extends Error {
  override name = "PaymentProofError";
  constructor(
    readonly code:
      | "BAD_ENCODING"
      | "NO_SUCH_OUTPUT"
      | "AMBIGUOUS_OUTPUT"
      | "SIGNATURE_MISMATCH"
      | "NOT_ENCRYPTED"
      | "WRONG_RECIPIENT"
      | "DOES_NOT_DECRYPT"
      | "UNKNOWN_ASSET"
      | "COMMITMENT_MISMATCH"
      | "SDK_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

export interface PaymentProof {
  readonly cluster: Cluster;
  readonly signature: Signature;
  readonly outputSlot: number;
  /** X25519(payee viewing secret, tx ephemeral public key). Opens only this payee's slot. */
  readonly sharedSecret: Uint8Array;
  readonly recipient: ShieldedAddress;
}

export interface VerifiedPayment {
  readonly signature: Signature;
  readonly slot: bigint;
  readonly outputSlot: number;
  readonly recipient: ShieldedAddress;
  /** The payee's Solana address (owner of the shielded address). */
  readonly owner: Address;
  readonly assetId: bigint;
  readonly mint: Address;
  readonly amount: bigint;
  /**
   * Raw memo bytes, if the output has one: its memo message, which the shared
   * secret also opens, or a legacy memo inside the output.
   */
  readonly memo?: Uint8Array;
}

// --- slot cipher (mirrors the SDK's applyTransferCipher) -----------------------

const encoder = new TextEncoder();
const HPKE_PREFIX = "TSPP/hpke/";
const ENC_INFO_TRANSFER = "TSPP/tx";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** AES-CTR over one slot, keyed from the shared secret. Encryption and decryption are the same. */
export function applySlotCipher(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: X25519PublicKey,
  recipientPublicKey: Uint8Array,
  input: Uint8Array,
  salt: Uint8Array,
  slotIndex: number,
): Uint8Array {
  const slot = new Uint8Array(4);
  new DataView(slot.buffer).setUint32(0, slotIndex, false);
  const ikm = concat(sharedSecret, ephemeralPublicKey.toBytes(), recipientPublicKey);
  const info = concat(encoder.encode(HPKE_PREFIX), encoder.encode(ENC_INFO_TRANSFER), salt, slot);
  const okm = hkdf(sha256, ikm, undefined, info, 44);
  try {
    const counter = new Uint8Array(16);
    counter.set(okm.subarray(32, 44));
    counter[15] = 2;
    return ctr(okm.subarray(0, 32), counter).encrypt(input.slice());
  } finally {
    okm.fill(0);
    ikm.fill(0);
  }
}

// --- helpers ---------------------------------------------------------------------

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function ownerOf(address: ShieldedAddress): Address {
  return getAddressDecoder().decode(address.signingPublicKey.ed25519());
}

function encryptedSlot(tx: IndexedShieldedTransaction, position: number) {
  const slot = tx.outputSlots[position];
  if (slot === undefined) throw new PaymentProofError("NO_SUCH_OUTPUT", `transaction has no output ${position}`);
  let frame;
  try {
    frame = decodeOutputData(slot.payload);
  } catch {
    return undefined;
  }
  if (
    frame.encoding !== "encrypted" ||
    (frame.scheme !== EncryptedScheme.confidential && frame.scheme !== EncryptedScheme.ringConfidential) ||
    frame.body.length <= KEY_LEN
  ) {
    return undefined;
  }
  return { slot, recipientKey: frame.body.slice(0, KEY_LEN), ciphertext: frame.body.slice(KEY_LEN) };
}

function txKeys(tx: IndexedShieldedTransaction) {
  if (tx.txViewingPublicKey === undefined || tx.salt === undefined) {
    throw new PaymentProofError("NOT_ENCRYPTED", "transaction publishes no transaction viewing key");
  }
  return { ephemeral: tx.txViewingPublicKey, salt: tx.salt };
}

// --- verify ----------------------------------------------------------------------

/** Check a proof against the transaction it names. Throws `PaymentProofError`. */
export function verifyPaymentProof(
  proof: PaymentProof,
  tx: IndexedShieldedTransaction,
  { assets = new AssetRegistry() }: Readonly<{ assets?: AssetRegistry }> = {},
): VerifiedPayment {
  if (tx.txSignature !== proof.signature) {
    throw new PaymentProofError("SIGNATURE_MISMATCH", "transaction does not match the proof's signature");
  }
  const { ephemeral, salt } = txKeys(tx);
  const found = encryptedSlot(tx, proof.outputSlot);
  if (found === undefined) throw new PaymentProofError("NOT_ENCRYPTED", `output ${proof.outputSlot} is not a confidential slot`);
  if (!eq(found.recipientKey, proof.recipient.viewingPublicKey.toBytes())) {
    throw new PaymentProofError("WRONG_RECIPIENT", `output ${proof.outputSlot} is not addressed to this payee`);
  }

  let plaintext: ReturnType<typeof decodeConfidential>;
  try {
    plaintext = decodeConfidential(
      applySlotCipher(proof.sharedSecret, ephemeral, found.recipientKey, found.ciphertext, salt, slotOrdinal(proof.outputSlot)),
    );
  } catch {
    throw new PaymentProofError("DOES_NOT_DECRYPT", "the proof's secret does not decrypt this output");
  }

  let mint: Address;
  try {
    mint = assets.resolve(plaintext.assetId);
  } catch {
    throw new PaymentProofError("UNKNOWN_ASSET", `asset id ${plaintext.assetId} is not in the registry given`);
  }
  const utxo = new Utxo({
    owner: proof.recipient.signingPublicKey,
    asset: mint,
    amount: plaintext.amount,
    blinding: plaintext.blinding,
    data: plaintext.data,
    ...(plaintext.ringProgramId === undefined ? {} : { ringProgramId: plaintext.ringProgramId }),
  });
  const hash = utxo.hash(proof.recipient.nullifierPublicKey, found.slot.outputContext.treeId ?? DEFAULT_TREE_ID);
  if (!eq(hash, found.slot.outputContext.hash)) {
    throw new PaymentProofError("COMMITMENT_MISMATCH", "the decrypted output does not match its onchain commitment");
  }
  const memo =
    readMemo(tx, proof.outputSlot, (data, ordinal) =>
      applySlotCipher(proof.sharedSecret, ephemeral, found.recipientKey, data, salt, ordinal),
    ) ?? plaintext.data.memo();
  return {
    signature: tx.txSignature,
    slot: tx.slot,
    outputSlot: proof.outputSlot,
    recipient: proof.recipient,
    owner: ownerOf(proof.recipient),
    assetId: plaintext.assetId,
    mint,
    amount: plaintext.amount,
    ...(memo === undefined ? {} : { memo }),
  };
}

// --- prove -----------------------------------------------------------------------

/** Anything holding the payee's viewing key and address (a ShieldedKeypair, for one). */
export interface PayeeKeys {
  viewingKey(): ViewingKey;
  shieldedAddress(): ShieldedAddress;
}

/**
 * Prove the payee's own output in `tx`. With several outputs to the payee,
 * `outputSlot` picks one. The proof is verified before it is returned.
 */
export function provePayment(
  payee: PayeeKeys,
  tx: IndexedShieldedTransaction,
  cluster: Cluster,
  { outputSlot, assets }: Readonly<{ outputSlot?: number; assets?: AssetRegistry }> = {},
): PaymentProof {
  const { ephemeral, salt } = txKeys(tx);
  const address = payee.shieldedAddress();
  const mine = address.viewingPublicKey.toBytes();
  const slots = tx.outputSlots
    .map((_, i) => i)
    .filter((i) => {
      const s = encryptedSlot(tx, i);
      return s !== undefined && eq(s.recipientKey, mine);
    });
  const position = outputSlot ?? (slots.length === 1 ? slots[0] : undefined);
  if (position === undefined) {
    throw slots.length === 0
      ? new PaymentProofError("NO_SUCH_OUTPUT", "this transaction has no output to this payee")
      : new PaymentProofError("AMBIGUOUS_OUTPUT", `several outputs to this payee (${slots.join(", ")}); pick one`);
  }
  if (!slots.includes(position)) throw new PaymentProofError("WRONG_RECIPIENT", `output ${position} is not to this payee`);

  const viewingKey = payee.viewingKey();
  try {
    const sharedSecret = viewingKey.ecdh(ephemeral);
    const found = encryptedSlot(tx, position)!;
    const ours = applySlotCipher(sharedSecret, ephemeral, found.recipientKey, found.ciphertext, salt, slotOrdinal(position));
    const sdk = viewingKey.decryptUtxo(found.ciphertext, ephemeral, salt, slotOrdinal(position));
    if (!eq(ours, sdk)) {
      throw new PaymentProofError("SDK_MISMATCH", "slot cipher no longer matches the SDK's; update payment-proof.ts");
    }
    const proof: PaymentProof = { cluster, signature: tx.txSignature, outputSlot: position, sharedSecret, recipient: address };
    verifyPaymentProof(proof, tx, assets === undefined ? {} : { assets });
    return proof;
  } finally {
    viewingKey.destroy();
  }
}

// --- encoding --------------------------------------------------------------------

export function encodePaymentProof(proof: PaymentProof): string {
  const sig = getBase58Encoder().encode(proof.signature);
  const address = proof.recipient.toBytes();
  if (sig.length !== 64 || proof.sharedSecret.length !== 32 || address.length !== ADDRESS_LEN) {
    throw new PaymentProofError("BAD_ENCODING", "proof fields have the wrong lengths");
  }
  const cluster = CLUSTERS.indexOf(proof.cluster);
  if (cluster < 0 || proof.outputSlot < 0 || proof.outputSlot > 0xffff) {
    throw new PaymentProofError("BAD_ENCODING", "bad cluster or output slot");
  }
  const bytes = new Uint8Array(BODY_LEN);
  bytes[0] = VERSION;
  bytes[1] = cluster;
  bytes.set(sig, 2);
  new DataView(bytes.buffer).setUint16(66, proof.outputSlot, true);
  bytes.set(proof.sharedSecret, 68);
  bytes.set(address, 100);
  return PAYMENT_PROOF_PREFIX + toBase64Url(bytes);
}

export function decodePaymentProof(encoded: string): PaymentProof {
  const text = encoded.trim();
  if (!text.startsWith(PAYMENT_PROOF_PREFIX)) {
    throw new PaymentProofError("BAD_ENCODING", `payment proofs start with ${PAYMENT_PROOF_PREFIX}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.slice(PAYMENT_PROOF_PREFIX.length));
  } catch {
    throw new PaymentProofError("BAD_ENCODING", "proof body is not base64url");
  }
  if (bytes.length !== BODY_LEN) throw new PaymentProofError("BAD_ENCODING", `proof body must be ${BODY_LEN} bytes`);
  if (bytes[0] !== VERSION) throw new PaymentProofError("BAD_ENCODING", `unsupported proof version ${bytes[0]}`);
  const cluster = CLUSTERS[bytes[1]!];
  if (cluster === undefined) throw new PaymentProofError("BAD_ENCODING", `unknown cluster id ${bytes[1]}`);
  let recipient: ShieldedAddress;
  try {
    recipient = ShieldedAddress.fromBytes(bytes.slice(100));
  } catch {
    throw new PaymentProofError("BAD_ENCODING", "proof carries an invalid shielded address");
  }
  return {
    cluster,
    signature: getBase58Decoder().decode(bytes.subarray(2, 66)) as Signature,
    outputSlot: new DataView(bytes.buffer, bytes.byteOffset).getUint16(66, true),
    sharedSecret: bytes.slice(68, 100),
    recipient,
  };
}
