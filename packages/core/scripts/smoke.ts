/**
 * Localnet smoke test: airdrop → deposit SOL → confidential transfer → decrypt.
 * Mirrors helius-labs/zolana-examples deposit_transfer_withdraw.ts.
 *
 *   scripts/install-zolana.sh && scripts/localnet.sh   # in another terminal
 *   pnpm --filter @ringstack/core smoke
 */
import { SOL_MINT, ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { LocalKeys, atSlot } from "@heliuslabs/zolana/client";
import { DepositAsset, depositInstruction, transactInstruction } from "@heliuslabs/zolana/interface";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, decryptToBalances } from "@heliuslabs/zolana/transaction";
import { lamports } from "@solana/kit";

import { clientConfigFromEnv } from "../src/config.ts";
import { sendAndConfirmFactory } from "../src/send.ts";

const DEPOSIT = 10_000_000n;
const TRANSFER = 3_000_000n;

await initializePoseidon();
const config = clientConfigFromEnv();
const client = await createZolanaClient(config);

const sender = ShieldedKeypair.generate();
const recipient = ShieldedKeypair.generate();
const signer = sender.toSolanaSigner();
const senderAddress = sender.shieldedAddress();
const senderKeys = LocalKeys.fromKeypair(sender, client.proofService);
const send = sendAndConfirmFactory(client, signer);
const assets = new AssetRegistry();

console.log(`sender ${signer.address}`);
const airdropSig = await client.solanaRpc.requestAirdrop(signer.address, lamports(1_000_000_000n)).send();
await client.confirmTransaction(airdropSig);

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
console.log(`deposit  ${deposit.signature}`);

const depositResp = await client.getShieldedTransactionsBySignature(deposit.signature, atSlot(deposit.slot));
const afterDeposit = (
  await decryptToBalances({
    keypair: sender,
    registry: assets,
    transactions: depositResp.transactions.map(({ transaction }) => transaction),
  })
).balance(SOL_MINT);
if (afterDeposit.amount !== DEPOSIT) throw new Error(`deposit: expected ${DEPOSIT}, got ${afterDeposit.amount}`);

const transfer = new ConfidentialTransfer(
  senderAddress,
  [ProofInputUtxo.fromKeypair(afterDeposit.utxos[0]!, sender)],
  signer.address,
);
transfer.send(recipient.shieldedAddress(), SOL_MINT, TRANSFER);
const data = await client.proveTransact(transfer.sign(sender, assets), senderKeys);
const transferTx = await send([
  await transactInstruction({
    payer: signer,
    ownerSigners: [signer],
    inputTree: client.tree,
    outputTree: client.tree,
    data,
  }),
]);
console.log(`transfer ${transferTx.signature}`);

const transferResp = await client.getShieldedTransactionsBySignature(transferTx.signature, atSlot(transferTx.slot));
const remaining = (
  await decryptToBalances({
    keypair: sender,
    registry: assets,
    transactions: transferResp.transactions.map(({ transaction }) => transaction),
  })
).balance(SOL_MINT);
if (remaining.amount !== DEPOSIT - TRANSFER) {
  throw new Error(`transfer: expected change ${DEPOSIT - TRANSFER}, got ${remaining.amount}`);
}
console.log(`ok: private change ${remaining.amount} lamports`);
