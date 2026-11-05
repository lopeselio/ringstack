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
  buildTransferTransaction,
  buildWithdrawalTransaction,
  syncWallet,
  type Address,
  type ShieldedAddress,
  type ShieldedKeypair,
  type SyncReport,
  type TransferDestination,
} from "@heliuslabs/zolana";
import { transactInstruction } from "@heliuslabs/zolana/interface";
import { ConfidentialTransfer, ProofInputUtxo } from "@heliuslabs/zolana/transaction";
import { fetchUserRecord, resolveRegisteredAddress } from "@heliuslabs/zolana/wallet";
import type { Transaction, TransactionPartialSigner } from "@solana/kit";

import { signTransferWithMemos } from "./memo.ts";
import { sendAndConfirmFactory, submitTransaction, type ConfirmedTransaction, type ZolanaClient } from "./send.ts";

/** Most inputs a memo transfer will spend; past this, merge first. */
export const MAX_MEMO_TRANSFER_INPUTS = 8;

export interface AssetOption {
  /** Mint; SOL when absent. */
  readonly asset?: Address;
}

export class RingSession {
  readonly client: ZolanaClient;
  readonly keypair: ShieldedKeypair;
  readonly signer: TransactionPartialSigner;
  readonly wallet: Wallet;
  readonly keys: LocalKeys;

  private constructor(client: ZolanaClient, keypair: ShieldedKeypair) {
    this.client = client;
    this.keypair = keypair;
    this.signer = keypair.toSolanaSigner();
    this.wallet = new Wallet({ identity: keypair.shieldedAddress() });
    this.keys = LocalKeys.fromKeypair(keypair, client.proofService);
  }

  /** Create a session and run the first wallet sync. */
  static async open(client: ZolanaClient, keypair: ShieldedKeypair): Promise<RingSession> {
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
   * Goes through the lower-level builder when `memo` is set (so the
   * recipient's output carries it) or when the wallet holds memo-bearing
   * UTXOs of `asset`, which the SDK's default selection skips (see memo.ts).
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

  /** Unshield to a public Solana address. */
  async withdraw(recipient: Address, amount: bigint, { asset }: AssetOption = {}): Promise<ConfirmedTransaction> {
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

  /** Merge this identity's UTXOs of one asset. Requires `setMerge(true)`. */
  async merge({ asset }: AssetOption = {}): Promise<ConfirmedTransaction> {
    const tx = await buildMergeTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.owner,
      ...(asset === undefined ? {} : { asset }),
    });
    return this.#submit(tx);
  }

  async #transferLowLevel(
    destination: TransferDestination,
    amount: bigint,
    asset: Address,
    memo: Uint8Array | undefined,
  ): Promise<ConfirmedTransaction> {
    const recipient = await this.#resolve(destination);
    const inputs = selectInputs(this.wallet, asset, amount).map((entry) =>
      ProofInputUtxo.fromKeypair(entry.utxo, this.keypair, {
        ...(entry.dataHash === undefined ? {} : { dataHash: entry.dataHash }),
        ...(entry.ringDataHash === undefined ? {} : { ringDataHash: entry.ringDataHash }),
      }),
    );
    const transfer = new ConfidentialTransfer(this.address, inputs, this.owner);
    transfer.send(recipient, asset, amount);
    const proofInputs = signTransferWithMemos(
      transfer,
      this.keypair,
      this.wallet.registry,
      memo === undefined ? [] : [{ recipient, memo }],
    );
    const data = await this.client.proveTransact(proofInputs, this.keys);
    const send = sendAndConfirmFactory(this.client, this.signer);
    const confirmed = await send([
      await transactInstruction({
        payer: this.signer,
        ownerSigners: [this.signer],
        inputTree: this.client.tree,
        outputTree: this.client.tree,
        data,
      }),
    ]);
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

type WalletEntry = ReturnType<Wallet["utxos"]>[number];

/** Spendable by the lower-level builder: no committed data, no ring, and data that is at most a memo. */
function isSpendable(e: WalletEntry, asset: Address): boolean {
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
