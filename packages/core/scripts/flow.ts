/**
 * Shared flow for scripts: fund → deposit SOL → confidential transfer (localnet or devnet).
 * Mirrors helius-labs/zolana-examples deposit_transfer_withdraw.ts.
 */
import { SOL_MINT, ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { LocalKeys, atSlot } from "@heliuslabs/spr/client";
import { DepositAsset, depositInstruction, transactInstruction } from "@heliuslabs/spr/interface";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, decryptToBalances } from "@heliuslabs/spr/transaction";

import { clientConfigFromEnv } from "../src/config.ts";
import { fund } from "../src/fund.ts";
import { signTransferWithMemos } from "../src/memo.ts";
import { sendAndConfirmFactory, type ConfirmedTransaction } from "../src/send.ts";

export const DEPOSIT = 10_000_000n;
export const TRANSFER = 3_000_000n;

export interface FlowOptions {
  readonly log?: (msg: string) => void;
  /** Encoded memo attached to the recipient's output (see memo.ts). */
  readonly memo?: Uint8Array;
}

export async function depositAndTransfer({ log = console.log, memo }: FlowOptions = {}) {
  await initializePoseidon();
  const client = await createSprClient(clientConfigFromEnv());

  const sender = ShieldedKeypair.generate();
  const recipient = ShieldedKeypair.generate();
  const signer = sender.toSolanaSigner();
  const senderAddress = sender.shieldedAddress();
  const send = sendAndConfirmFactory(client, signer);
  const assets = new AssetRegistry();

  log(`sender   ${signer.address}`);
  await fund(client, signer.address, DEPOSIT + 20_000_000n);

  const deposit = await send([
    await depositInstruction({
      tree: client.tree,
      depositor: signer,
      deposits: [
        {
          asset: DepositAsset.sol(),
          viewTag: senderAddress.confidentialViewTag(),
          recipientOwnerHash: senderAddress.ownerHash(),
          amount: DEPOSIT,
        },
      ],
    }),
  ]);
  log(`deposit  ${deposit.signature}`);

  const balanceAfter = async (tx: ConfirmedTransaction) => {
    const resp = await client.getShieldedTransactionsBySignature(tx.signature, atSlot(tx.slot));
    return (
      await decryptToBalances({
        keypair: sender,
        registry: assets,
        transactions: resp.transactions.map(({ transaction }) => transaction),
      })
    ).balance(SOL_MINT);
  };

  const afterDeposit = await balanceAfter(deposit);
  if (afterDeposit.amount !== DEPOSIT) throw new Error(`deposit: expected ${DEPOSIT}, got ${afterDeposit.amount}`);

  const transfer = new ConfidentialTransfer(
    senderAddress,
    [ProofInputUtxo.fromKeypair(afterDeposit.utxos[0]!, sender)],
    signer.address,
  );
  transfer.send(recipient.shieldedAddress(), SOL_MINT, TRANSFER);
  const inputs =
    memo === undefined
      ? transfer.sign(sender, assets)
      : signTransferWithMemos(transfer, sender, assets, [{ recipient: recipient.shieldedAddress(), memo }]);
  const data = await client.proveTransact(inputs, LocalKeys.fromKeypair(sender, client.proofService));
  const transferTx = await send([
    await transactInstruction({
      payer: signer,
      ownerSigners: [signer],
      inputTree: client.tree,
      outputTree: client.tree,
      data,
    }),
  ]);
  log(`transfer ${transferTx.signature}`);

  const remaining = await balanceAfter(transferTx);
  if (remaining.amount !== DEPOSIT - TRANSFER) {
    throw new Error(`transfer: expected change ${DEPOSIT - TRANSFER}, got ${remaining.amount}`);
  }

  return { client, sender, recipient, assets, deposit, transferTx, change: remaining.amount };
}
