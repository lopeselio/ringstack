/**
 * Issue and open RingPay receipts (spec/receipt.md).
 *
 * Built only from public SDK exports. The flow mirrors the SDK's own
 * sender-side decode (`Wallet#decodeOutboundSlots`): the transaction key is
 * `senderViewingKey.transactionViewingKey(tx.nullifiers[0])`, and each
 * confidential slot body is `recipientViewingPk(33) || ciphertext`.
 */
import { ViewingKey, type ShieldedAddress } from "@heliuslabs/spr";
import { DEFAULT_TREE_ID } from "@heliuslabs/spr/interface";
import { X25519PublicKey, bytes32, type Bytes32 } from "@heliuslabs/spr/keypair";
import {
  AssetRegistry,
  EncryptedScheme,
  Utxo,
  decodeConfidential,
  decodeOutputData,
  type IndexedShieldedTransaction,
} from "@heliuslabs/spr/transaction";
import type { Address, Signature } from "@solana/kit";

import type { Cluster, Receipt } from "./receipt.ts";
import { readMemo } from "./memo.ts";

const EMBEDDED_KEY_LENGTH = 33;

export class ReceiptError extends Error {
  constructor(
    readonly code:
      | "NO_INPUTS"
      | "NOT_ENCRYPTED"
      | "KEY_MISMATCH"
      | "SIGNATURE_MISMATCH"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ReceiptError";
  }
}

/** Anything that exposes the sender's transaction-key derivation (ShieldedKeypair, ViewingKey). */
export interface TransactionKeySource {
  transactionViewingKey(firstNullifier: Bytes32): ViewingKey;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function firstNullifier(tx: IndexedShieldedTransaction): Bytes32 {
  const nullifier = tx.nullifiers[0];
  if (nullifier === undefined) throw new ReceiptError("NO_INPUTS", "transaction spends no inputs");
  return nullifier;
}

function requireEncrypted(tx: IndexedShieldedTransaction) {
  const { txViewingPublicKey, salt } = tx;
  if (txViewingPublicKey === undefined || salt === undefined) {
    throw new ReceiptError("NOT_ENCRYPTED", "transaction publishes no transaction viewing key");
  }
  return { txViewingPublicKey, salt };
}

/**
 * Sender side: derive the transaction key for `tx` and package it as a receipt.
 * Throws KEY_MISMATCH if `sender` did not create the transaction.
 */
export function issueReceipt(
  sender: TransactionKeySource,
  tx: IndexedShieldedTransaction,
  cluster: Cluster,
): Receipt {
  const { txViewingPublicKey } = requireEncrypted(tx);
  const txKey = sender.transactionViewingKey(firstNullifier(tx));
  try {
    if (!equalBytes(txKey.publicKey().toBytes(), txViewingPublicKey.toBytes())) {
      throw new ReceiptError("KEY_MISMATCH", "sender's transaction key does not match the published one");
    }
    return { cluster, signature: tx.txSignature, txViewingKey: txKey.secretBytes(), slot: tx.slot };
  } finally {
    txKey.destroy();
  }
}

export type CommitmentCheck =
  /** Recomputed UTXO commitment equals the onchain leaf for this slot. */
  | "verified"
  /** Commitment did not match: the sender encrypted something other than what was committed. */
  | "mismatch"
  /** No known address for this recipient key, so the commitment was not recomputed. */
  | "unchecked";

export interface ReceiptOutput {
  readonly slot: number;
  readonly recipientViewingKey: X25519PublicKey;
  /** The matching address from `knownAddresses`, if any. */
  readonly recipient?: ShieldedAddress;
  readonly assetId: bigint;
  /** Undefined when the asset id is not in the supplied registry. */
  readonly mint?: Address;
  readonly amount: bigint;
  /**
   * Raw memo bytes, if the output has one: its memo message (see memo.ts), or
   * a legacy memo inside the output. Not covered by the commitment, but
   * authentic: its ciphertext is bound by `external_data_hash`.
   */
  readonly memo?: Uint8Array;
  readonly commitment: CommitmentCheck;
}

export interface OpenedReceipt {
  readonly signature: Signature;
  readonly slot: bigint;
  readonly outputs: readonly ReceiptOutput[];
}

export interface OpenReceiptOptions {
  /**
   * Addresses whose outputs can be fully verified (commitment recomputed).
   * E.g. the merchant's own address for a RingPay payment.
   */
  readonly knownAddresses?: readonly ShieldedAddress[];
  /** Resolves asset ids to mints. Defaults to an empty registry (SOL resolves built-in). */
  readonly assets?: AssetRegistry;
}

/**
 * Verifier side: decrypt every confidential output of `tx` with the receipt's
 * transaction key. Dummy/padding slots fail decryption and are skipped.
 */
export function openReceipt(
  receipt: Receipt,
  tx: IndexedShieldedTransaction,
  options: OpenReceiptOptions = {},
): OpenedReceipt {
  if (tx.txSignature !== receipt.signature) {
    throw new ReceiptError("SIGNATURE_MISMATCH", "transaction does not match the receipt signature");
  }
  const { txViewingPublicKey, salt } = requireEncrypted(tx);
  const txKey = ViewingKey.fromBytes(bytes32(receipt.txViewingKey));
  const assets = options.assets ?? new AssetRegistry();
  const known = options.knownAddresses ?? [];
  try {
    if (!equalBytes(txKey.publicKey().toBytes(), txViewingPublicKey.toBytes())) {
      throw new ReceiptError("KEY_MISMATCH", "receipt key does not match the transaction's viewing key");
    }
    const outputs: ReceiptOutput[] = [];
    tx.outputSlots.forEach((slot, position) => {
      let frame: ReturnType<typeof decodeOutputData>;
      try {
        frame = decodeOutputData(slot.payload);
      } catch {
        return;
      }
      if (
        frame.encoding !== "encrypted" ||
        (frame.scheme !== EncryptedScheme.confidential && frame.scheme !== EncryptedScheme.ringConfidential) ||
        frame.body.length < EMBEDDED_KEY_LENGTH
      ) {
        return;
      }
      const recipientViewingKey = X25519PublicKey.fromBytes(frame.body.slice(0, EMBEDDED_KEY_LENGTH));
      let plaintext: ReturnType<typeof decodeConfidential>;
      try {
        plaintext = decodeConfidential(
          txKey.decryptSlotEphemeral(recipientViewingKey, frame.body.slice(EMBEDDED_KEY_LENGTH), salt, position),
        );
      } catch {
        return; // padding slot
      }

      let mint: Address | undefined;
      try {
        mint = assets.resolve(plaintext.assetId);
      } catch {
        mint = undefined;
      }

      const recipient = known.find((a) => equalBytes(a.viewingPublicKey.toBytes(), recipientViewingKey.toBytes()));
      let commitment: CommitmentCheck = "unchecked";
      if (recipient !== undefined && mint !== undefined) {
        const utxo = new Utxo({
          owner: recipient.signingPublicKey,
          asset: mint,
          amount: plaintext.amount,
          blinding: plaintext.blinding,
          data: plaintext.data,
          ...(plaintext.ringProgramId === undefined ? {} : { ringProgramId: plaintext.ringProgramId }),
        });
        const treeId = slot.outputContext.treeId ?? DEFAULT_TREE_ID;
        const hash = utxo.hash(recipient.nullifierPublicKey, treeId);
        commitment = equalBytes(hash, slot.outputContext.hash) ? "verified" : "mismatch";
      }

      const memo =
        readMemo(tx, position, (data, ordinal) => txKey.decryptSlotEphemeral(recipientViewingKey, data, salt, ordinal)) ??
        plaintext.data.memo();
      outputs.push({
        slot: position,
        recipientViewingKey,
        ...(recipient === undefined ? {} : { recipient }),
        assetId: plaintext.assetId,
        ...(mint === undefined ? {} : { mint }),
        amount: plaintext.amount,
        ...(memo === undefined ? {} : { memo }),
        commitment,
      });
    });
    return { signature: tx.txSignature, slot: tx.slot, outputs };
  } finally {
    txKey.destroy();
  }
}

/** Minimal client surface needed to look a transaction up. */
export interface ShieldedTransactionReader {
  getShieldedTransactionsBySignature(
    signature: Signature,
  ): Promise<{ transactions: readonly { transaction: IndexedShieldedTransaction }[] }>;
}

export async function fetchShieldedTransaction(
  client: ShieldedTransactionReader,
  signature: Signature,
): Promise<IndexedShieldedTransaction> {
  const resp = await client.getShieldedTransactionsBySignature(signature);
  const tx = resp.transactions.find(({ transaction }) => transaction.txSignature === signature)?.transaction;
  if (tx === undefined) throw new ReceiptError("NOT_FOUND", `no shielded transaction for ${signature}`);
  return tx;
}
