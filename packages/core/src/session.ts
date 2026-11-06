/**
 * One shielded identity bound to a client: register, toggle merge, deposit,
 * transfer (optionally with an encrypted memo), withdraw, merge.
 *
 * Every operation signs with the identity's own Ed25519 key (owner = fee
 * payer), waits for confirmation, then syncs the wallet at the landed slot, so
 * `balance()` is current when the call returns.
 */
import {
  LocalKeys,
  MergeEncryptionScheme,
  SOL_MINT,
  Wallet,
  buildDepositTransaction,
  buildMergeTransaction,
  buildRegistrationTransaction,
  buildSetMergeEncryptionTransaction,
  buildSplitTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  syncWallet,
  type Address,
  type ShieldedAddress,
  type ShieldedKeypair,
  type SyncReport,
  type TransferDestination,
} from "@heliuslabs/spr";
import { TransactWithdrawal, transactInstruction } from "@heliuslabs/spr/interface";
import { ConfidentialTransfer, ProofInputUtxo, WithdrawalTarget } from "@heliuslabs/spr/transaction";
import { fetchUserRecord, resolveRegisteredAddress } from "@heliuslabs/spr/wallet";
import type { Signature, Transaction, TransactionPartialSigner } from "@solana/kit";

import { buildMerge } from "./merge.ts";
import { decodeMemo, receivedMemos, signTransferWithMemos, type OutputMemo } from "./memo.ts";
import { fetchShieldedTransaction } from "./receipt-open.ts";
import { hasMemoUtxos, isSpendable, type WalletEntry } from "./utxos.ts";
import {
  sendAndConfirmFactory,
  submitTransaction,
  type ConfirmedTransaction,
  type SendHooks,
  type SprClient,
} from "./send.ts";

/** Most inputs a memo transfer will spend; past this, merge first. */
export const MAX_MEMO_TRANSFER_INPUTS = 8;

/** Most payees in one transaction: 16 outputs minus the change output. */
export const MAX_BATCH_PAYMENTS = 15;

export interface BatchPayment {
  readonly recipient: TransferDestination;
  readonly amount: bigint;
  /** Encoded memo for this payee's output (see memo.ts). */
  readonly memo?: Uint8Array;
}

export interface TransferManyOptions extends AssetOption, SendHooks {
  /** Spend exactly these UTXOs (e.g. a disjoint set per concurrent batch); selected automatically otherwise. */
  readonly inputs?: readonly WalletEntry[];
}

export interface AssetOption {
  /** Mint; SOL when absent. */
  readonly asset?: Address;
}

export class RingSession {
  readonly client: SprClient;
  readonly keypair: ShieldedKeypair;
  readonly signer: TransactionPartialSigner;
  readonly wallet: Wallet;
  readonly keys: LocalKeys;

  private constructor(client: SprClient, keypair: ShieldedKeypair) {
    this.client = client;
    this.keypair = keypair;
    this.signer = keypair.toSolanaSigner();
    this.wallet = new Wallet({ identity: keypair.shieldedAddress() });
    this.keys = LocalKeys.fromKeypair(keypair, client.proofService);
  }

  /** Create a session and run the first wallet sync. */
  static async open(client: SprClient, keypair: ShieldedKeypair): Promise<RingSession> {
    const session = new RingSession(client, keypair);
    await session.sync();
    return session;
  }

  /** Solana address of the owner (registry key, fee payer). */
  get owner(): Address {
    return this.signer.address;
  }

  get address(): ShieldedAddress {
    return this.wallet.identity;
  }

  sync(requireSlot?: bigint): Promise<SyncReport> {
    return syncWallet({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      ...(requireSlot === undefined ? {} : { config: { requireSlot } }),
    });
  }

  /**
   * Memos this identity received in transaction `signature`, by the leaf
   * index of the output they describe. Reads memo messages and, for payments
   * sent before memos moved to messages, memos inside synced outputs.
   */
  async receivedMemos(signature: Signature): Promise<Map<bigint, string>> {
    const tx = await fetchShieldedTransaction(this.client, signature);
    const viewingKey = this.keypair.viewingKey();
    try {
      const memos = receivedMemos(tx, this.address, viewingKey);
      for (const slot of tx.outputSlots) {
        const leaf = slot.outputContext.leafIndex;
        const entry = this.wallet.utxos().find((e) => e.outputContext.leafIndex === leaf);
        const legacy = decodeMemo(entry?.utxo.data.memo());
        if (legacy !== undefined && !memos.has(leaf)) memos.set(leaf, legacy);
      }
      return memos;
    } finally {
      viewingKey.destroy();
    }
  }

  /** Spendable default-ring balance as of the last sync. */
  balance(asset: Address = SOL_MINT): bigint {
    return this.wallet.balance(asset).amount;
  }

  /** Publish this identity in the user registry. Undefined when already registered with these keys. */
  async register(): Promise<ConfirmedTransaction | undefined> {
    const tx = await buildRegistrationTransaction({ client: this.client, owner: this.owner, address: this.address });
    return tx === undefined ? undefined : this.#submit(tx);
  }

  /** Whether the registry record lets anyone merge this owner's UTXOs. Undefined when unregistered. */
  async mergeEnabled(): Promise<boolean | undefined> {
    const record = await fetchUserRecord({ rpc: this.client, owner: this.owner });
    return record === undefined ? undefined : record.mergeEncryption !== MergeEncryptionScheme.Disabled;
  }

  /** Opt in to (or out of) third-party merges, e.g. ringd auto-merge. Requires registration. */
  async setMerge(enabled: boolean): Promise<ConfirmedTransaction> {
    const tx = await buildSetMergeEncryptionTransaction({
      client: this.client,
      owner: this.owner,
      scheme: enabled ? MergeEncryptionScheme.PoseidonCtrV1 : MergeEncryptionScheme.Disabled,
    });
    return this.#submit(tx);
  }

  /** Shield public funds. Pays this identity unless `recipient` is given. */
  async deposit(
    amount: bigint,
    { asset, recipient, memo }: AssetOption & { recipient?: Address | ShieldedAddress; memo?: Uint8Array } = {},
  ): Promise<ConfirmedTransaction> {
    const tx = await buildDepositTransaction({
      client: this.client,
      feePayer: this.owner,
      recipient: recipient ?? this.address,
      amount,
      ...(asset === undefined ? {} : { asset }),
      ...(memo === undefined ? {} : { memo }),
    });
    return this.#submit(tx);
  }

  /**
   * Private transfer. A plain `Address` is resolved through the registry.
   * Goes through the lower-level builder when `memo` is set (the SDK's
   * builders take no messages, see memo.ts) or when the wallet still holds
   * legacy memo-bearing UTXOs of `asset`, which the SDK's default selection skips.
   */
  async transfer(
    recipient: TransferDestination,
    amount: bigint,
    { asset, memo }: AssetOption & { memo?: Uint8Array } = {},
  ): Promise<ConfirmedTransaction> {
    const mint = asset ?? SOL_MINT;
    if (memo !== undefined || hasMemoUtxos(this.wallet, mint)) {
      return this.#transferLowLevel(recipient, amount, mint, memo);
    }
    const tx = await buildTransferTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.owner,
      recipient,
      amount,
      ...(asset === undefined ? {} : { asset }),
    });
    return this.#submit(tx);
  }

  /**
   * Unshield to a public Solana address. Falls back to the lower-level builder
   * when the wallet holds legacy memo-bearing UTXOs of `asset` (SOL only for now).
   */
  async withdraw(recipient: Address, amount: bigint, { asset }: AssetOption = {}): Promise<ConfirmedTransaction> {
    const mint = asset ?? SOL_MINT;
    if (hasMemoUtxos(this.wallet, mint)) {
      if (mint !== SOL_MINT) {
        throw new Error("withdrawing SPL funds that include memo payments is not supported yet");
      }
      return this.#spendLowLevel(mint, amount, (t) => t.withdraw(mint, amount, WithdrawalTarget.sol({ recipient })), {
        withdrawal: TransactWithdrawal.sol({ recipient }),
      });
    }
    const tx = await buildWithdrawalTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.owner,
      recipient,
      amount,
      ...(asset === undefined ? {} : { asset }),
    });
    return this.#submit(tx);
  }

  /**
   * Merge this identity's UTXOs of one asset. Requires `setMerge(true)`.
   *
   * The SDK refuses merge inputs whose data is non-empty, legacy memos included. A memo
   * is outside the commitment, so a memo UTXO rebuilt without it hashes to the
   * same leaf; those rebuilt inputs go through the lower-level `Merge`. The
   * merged output carries no memo.
   */
  async merge({ asset }: AssetOption = {}): Promise<ConfirmedTransaction> {
    const mint = asset ?? SOL_MINT;
    if (hasMemoUtxos(this.wallet, mint)) return this.#mergeLowLevel(mint);
    const tx = await buildMergeTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.owner,
      asset: mint,
    });
    return this.#submit(tx);
  }

  /**
   * One private transaction paying up to 15 recipients, each as its own
   * output with an optional memo. A recipient may appear only once (memos are
   * matched to outputs by recipient).
   */
  async transferMany(
    payments: readonly BatchPayment[],
    { asset, inputs, beforeSend }: TransferManyOptions = {},
  ): Promise<ConfirmedTransaction> {
    if (payments.length === 0 || payments.length > MAX_BATCH_PAYMENTS) {
      throw new Error(`a batch pays 1–${MAX_BATCH_PAYMENTS} recipients, got ${payments.length}`);
    }
    const mint = asset ?? SOL_MINT;
    const resolved = await Promise.all(payments.map((p) => this.#resolve(p.recipient)));
    const keys = resolved.map((a) => Buffer.from(a.viewingPublicKey.toBytes()).toString("hex"));
    if (new Set(keys).size !== keys.length) throw new Error("a recipient appears twice in one batch");
    const total = payments.reduce((sum, p) => sum + p.amount, 0n);
    return this.#spendLowLevel(
      mint,
      total,
      (t) => resolved.forEach((recipient, i) => t.send(recipient, mint, payments[i]!.amount)),
      {
        memos: resolved.flatMap((recipient, i) => {
          const memo = payments[i]!.memo;
          return memo === undefined ? [] : [{ recipient, memo }];
        }),
        ...(inputs === undefined ? {} : { inputs }),
        ...(beforeSend === undefined ? {} : { beforeSend }),
      },
    );
  }

  /** Split this identity's balance of one asset into `parts` equal UTXOs, for concurrent spends. */
  async split(parts: number, { asset }: AssetOption = {}): Promise<ConfirmedTransaction> {
    const tx = await buildSplitTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.owner,
      parts,
      ...(asset === undefined ? {} : { asset }),
    });
    return this.#submit(tx);
  }

  async #mergeLowLevel(asset: Address): Promise<ConfirmedTransaction> {
    const nullifierKey = this.keypair.nullifierKey();
    try {
      const { transaction } = await buildMerge({
        client: this.client,
        wallet: this.wallet,
        authority: { address: this.address, nullifierKey },
        keys: this.keys,
        feePayer: this.owner,
        asset,
      });
      return await this.#submit(transaction);
    } finally {
      nullifierKey.destroy();
    }
  }


  async #transferLowLevel(
    destination: TransferDestination,
    amount: bigint,
    asset: Address,
    memo: Uint8Array | undefined,
  ): Promise<ConfirmedTransaction> {
    const recipient = await this.#resolve(destination);
    return this.#spendLowLevel(asset, amount, (t) => t.send(recipient, asset, amount), {
      memos: memo === undefined ? [] : [{ recipient, memo }],
    });
  }

  /**
   * Spend through `ConfidentialTransfer`, selecting plain and memo-only UTXOs.
   * `build` adds the transfer's outputs (a send or a withdrawal).
   */
  async #spendLowLevel(
    asset: Address,
    amount: bigint,
    build: (transfer: ConfidentialTransfer) => void,
    {
      memos = [],
      withdrawal,
      inputs: chosen,
      beforeSend,
    }: Readonly<{
      memos?: readonly OutputMemo[];
      withdrawal?: TransactWithdrawal;
      inputs?: readonly WalletEntry[];
      beforeSend?: SendHooks["beforeSend"];
    }> = {},
  ): Promise<ConfirmedTransaction> {
    const entries = chosen ?? selectInputs(this.wallet, asset, amount);
    if (chosen !== undefined) {
      const covered = chosen.reduce((sum, e) => sum + e.utxo.amount, 0n);
      if (covered < amount) throw new Error(`given inputs hold ${covered}, need ${amount}`);
      if (!chosen.every((e) => isSpendable(e, asset))) throw new Error("given inputs are not all spendable");
    }
    const inputs = entries.map((entry) => ProofInputUtxo.fromKeypair(entry.utxo, this.keypair));
    const transfer = new ConfidentialTransfer(this.address, inputs, this.owner);
    build(transfer);
    const proofInputs = signTransferWithMemos(transfer, this.keypair, this.wallet.registry, memos);
    const data = await this.client.proveTransact(proofInputs, this.keys);
    const send = sendAndConfirmFactory(this.client, this.signer);
    const confirmed = await send(
      [
        await transactInstruction({
          payer: this.signer,
          ownerSigners: [this.signer],
          inputTree: this.client.tree,
          outputTree: this.client.tree,
          ...(withdrawal === undefined ? {} : { withdrawal }),
          data,
        }),
      ],
      beforeSend === undefined ? {} : { beforeSend },
    );
    await this.sync(confirmed.slot);
    return confirmed;
  }

  async #resolve(destination: TransferDestination): Promise<ShieldedAddress> {
    if (typeof destination !== "string") return destination;
    const resolved = await resolveRegisteredAddress({ rpc: this.client, owner: destination });
    if (resolved === undefined) throw new Error(`recipient ${destination} is not registered`);
    return resolved.address;
  }

  async #submit(tx: Transaction): Promise<ConfirmedTransaction> {
    const confirmed = await submitTransaction(this.client, [this.signer], tx);
    await this.sync(confirmed.slot);
    return confirmed;
  }
}

/** Largest-first selection of unspent default-ring UTXOs covering `amount`. */
export function selectInputs(wallet: Wallet, asset: Address, amount: bigint): WalletEntry[] {
  const candidates = wallet
    .utxos()
    .filter((e) => isSpendable(e, asset))
    .sort((a, b) => (a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount > b.utxo.amount ? -1 : 1));
  const picked: WalletEntry[] = [];
  let total = 0n;
  for (const entry of candidates) {
    if (total >= amount) break;
    picked.push(entry);
    total += entry.utxo.amount;
  }
  if (total < amount) throw new Error(`insufficient private balance: have ${total}, need ${amount}`);
  if (picked.length > MAX_MEMO_TRANSFER_INPUTS) {
    throw new Error(`transfer needs ${picked.length} inputs (max ${MAX_MEMO_TRANSFER_INPUTS}); merge first`);
  }
  return picked;
}
