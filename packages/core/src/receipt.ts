import { getBase58Decoder, getBase58Encoder, type Signature } from "@solana/kit";

import { fromBase64Url, toBase64Url } from "./base64url.ts";

/**
 * A RingPay receipt discloses exactly one private transaction: the
 * transaction signature plus that transaction's viewing key
 * (`ViewingKey.transactionViewingKey(firstNullifier)`), which decrypts only
 * that transaction's output slots. See spec/receipt.md.
 *
 * Wire format (binary, then base64url, prefixed `ringrcpt1:`):
 *   u8  version (=1)
 *   u8  cluster (0 localnet, 1 devnet, 2 mainnet)
 *   64  transaction signature
 *   32  transaction viewing key secret
 *   u64 landed slot, little-endian (optional; 0 = unknown)
 */
export const RECEIPT_PREFIX = "ringrcpt1:";
export const RECEIPT_VERSION = 1;

export type Cluster = "localnet" | "devnet" | "mainnet";
const CLUSTERS: readonly Cluster[] = ["localnet", "devnet", "mainnet"];

export interface Receipt {
  readonly cluster: Cluster;
  readonly signature: Signature;
  /** 32-byte X25519 secret of the transaction viewing key. Treat as sensitive. */
  readonly txViewingKey: Uint8Array;
  readonly slot?: bigint;
}

const SIG_LEN = 64;
const KEY_LEN = 32;
const BODY_LEN = 2 + SIG_LEN + KEY_LEN + 8;

export function encodeReceipt(receipt: Receipt): string {
  const sig = getBase58Encoder().encode(receipt.signature);
  if (sig.length !== SIG_LEN) throw new Error("signature must decode to 64 bytes");
  if (receipt.txViewingKey.length !== KEY_LEN) throw new Error("txViewingKey must be 32 bytes");
  const cluster = CLUSTERS.indexOf(receipt.cluster);
  if (cluster < 0) throw new Error(`unknown cluster ${receipt.cluster}`);
  const slot = receipt.slot ?? 0n;
  if (slot < 0n || slot > 0xffff_ffff_ffff_ffffn) throw new Error("slot out of u64 range");

  const bytes = new Uint8Array(BODY_LEN);
  bytes[0] = RECEIPT_VERSION;
  bytes[1] = cluster;
  bytes.set(sig, 2);
  bytes.set(receipt.txViewingKey, 2 + SIG_LEN);
  new DataView(bytes.buffer).setBigUint64(2 + SIG_LEN + KEY_LEN, slot, true);
  return RECEIPT_PREFIX + toBase64Url(bytes);
}

export function decodeReceipt(encoded: string): Receipt {
  if (!encoded.startsWith(RECEIPT_PREFIX)) throw new Error(`receipt must start with ${RECEIPT_PREFIX}`);
  const bytes = fromBase64Url(encoded.slice(RECEIPT_PREFIX.length));
  if (bytes.length !== BODY_LEN) throw new Error(`receipt body must be ${BODY_LEN} bytes, got ${bytes.length}`);
  if (bytes[0] !== RECEIPT_VERSION) throw new Error(`unsupported receipt version ${bytes[0]}`);
  const cluster = CLUSTERS[bytes[1]!];
  if (!cluster) throw new Error(`unknown cluster id ${bytes[1]}`);

  const signature = getBase58Decoder().decode(bytes.subarray(2, 2 + SIG_LEN)) as Signature;
  const txViewingKey = bytes.slice(2 + SIG_LEN, 2 + SIG_LEN + KEY_LEN);
  const slot = new DataView(bytes.buffer).getBigUint64(2 + SIG_LEN + KEY_LEN, true);
  return slot === 0n ? { cluster, signature, txViewingKey } : { cluster, signature, txViewingKey, slot };
}
