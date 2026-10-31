# Milestone 0 SDK checks

Date: 2026-10-31 · Sources: `helius-labs/zolana@v0.6.0-alpha` (8ae430a), `@heliuslabs/zolana@0.6.0-alpha` (npm), `helius-labs/zolana-examples@main`.

## Versions

| Artifact | Version | Notes |
|---|---|---|
| zolana GitHub release | `v0.6.0-alpha` (2026-10-28) | Prebuilt CLI, prover, Photon for darwin-arm64 + linux-x64 |
| npm `@heliuslabs/zolana` | `0.6.0-alpha` pinned; `0.7.0-alpha` exists (tag `alpha`), `latest` is still 0.5.0 | 0.6 and 0.7 both target `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW` |
| Node | ≥ 24 (SDK `engines`) | `.nvmrc` = 24 |

**Decision:** pin `0.6.0-alpha` to match the release binaries `zolana dev start` downloads. Revisit 0.7 once a matching GitHub release ships.

## Check 1: receipts (transaction viewing key): ✅ supported

- Each transaction has its own key: `ViewingKey.transactionViewingKey(firstNullifier)`.
- Export/import: `secretBytes()` / `ViewingKey.fromBytes()`.
- Decrypt one slot: `decryptSlotEphemeral(recipientViewingPk, ciphertext, salt, slotIndex)`, or `decryptConfidentialAsSender(txKey, body, salt, slotIndex)`.
- Spec drafted: [spec/receipt.md](../../spec/receipt.md). Codec implemented and tested.
- **Verified on localnet (2026-11-01)** with `pnpm --filter @ringstack/core receipt:e2e`: the sender issues a 152-character receipt, and a verifier decrypts the payment and change outputs and recomputes both commitments (`verified`). A third party can't issue a receipt, a tampered key is rejected, and the receipt doesn't open a different transaction.
- `firstNullifier` = `tx.nullifiers[0]` from the indexer, so a receipt can be issued later from the signature alone.
- Each confidential slot body embeds the recipient's viewing key (`pk(33) || ciphertext`), so verifiers need no registry lookup to decrypt.
- The SDK's sender-side helpers (`decryptConfidentialAsSender`, `confidentialUtxo`) are not exported, so `receipt-open.ts` rebuilds them from public exports (`decodeOutputData`, `decodeConfidential`, `ViewingKey.decryptSlotEphemeral`, `Utxo`).

## Check 2: payroll batching: ✅ supported (high-level)

- `createMultiTransfer({ wallet, payer, asset, payments: [{recipient, amount}] })`, with each payment as its own output, in order.
- Limit: `MAX_TRANSFER_PAYMENTS = max(shape.outputs) - 1` = **15** payees per transaction (16 outputs minus change).
- The SDK picks the shape automatically; no need to force a variant.
- `TransferDestination = Address | ShieldedAddress`: plain addresses are resolved via the registry.
- `createSplit({ wallet, payer, asset, parts })` pre-splits treasury UTXOs so batches can run concurrently.

## Memos: ✅ works via prepare/finalize (verified on localnet)

- High-level `createTransfer` / `createMultiTransfer` and `ConfidentialTransfer#send` take **no memo**.
- `deposit` accepts `memo`. For transfers, memos go through `ProofOutputUtxo.withMemo(bytes)`.
- A memo is a `Data` record (`kind: "memo"`) inside the output's **confidential plaintext**, so only the owner and transaction-key holders read it. It is **not** in the UTXO commitment; its ciphertext is bound by `external_data_hash`.
- Recipe (`core/src/memo.ts` `signTransferWithMemos`): `transfer.prepare()` → map `prepared.outputs` to `output.withMemo(m)` → `encodeConfidentialSlots(outputs, assets, txKey, salt)` → `prepared.finalize({ txViewingPublicKey, salt, payload })`. `finalize` hashes the original outputs, which is fine because the memo does not change the commitment. All public exports.
- Recipient: `decryptToBalances(...).balance(mint).utxos[i].data.memo()`. Receipt: `openReceipt` returns `memo` per output.
- **Length leak:** a memo lengthens its slot ciphertext (32-byte memo: 124-byte slot payload). Mitigation in core: fixed-width memos (`MEMO_LENGTH = 32`, zero-padded) and every real output, change included, gets one, so real slots match. Random padding slots are still sized for an empty plaintext, so in shapes with padding the padded slots stay distinguishable. Ask upstream for a padded dummy length or a memo-aware `dummyCiphertextLength`.
- Alternative: `withUtxoData(data, dataHash)` is committed, but SPP does not check `dataHash`, so readers must recompute it.
- Localnet: `pnpm --filter @ringstack/core memo:e2e` (recipient reads `order:…`, receipt shows it next to a `verified` amount, both slots 124 bytes).

## Wallet helpers: ✅ verified on localnet

- The SDK's `build*Transaction` functions (`Registration`, `SetMergeEncryption`, `Deposit`, `Transfer`, `Withdrawal`, `Merge`) return compiled kit transactions. Sign with `signTransactionWithSigners`, send, `client.confirmTransaction` for the slot, then `syncWallet({ requireSlot })`.
- `core/src/session.ts` `RingSession` wraps that loop per identity; memo transfers go through `signTransferWithMemos` with largest-first input selection from `wallet.utxos()` (capped at 8 inputs).
- Registration is idempotent: `buildRegistrationTransaction` returns `undefined` when the record already holds the same keys.
- **Merging needs the opt-in even for your own UTXOs**: `buildMergeTransaction` rejects unless the owner's registry record has `mergeEncryption = PoseidonCtrV1` (`buildSetMergeEncryptionTransaction`). New records start `Disabled`. With it enabled, anyone may merge for the owner (that is what ringd auto-merge will use).
- Localnet: `pnpm --filter @ringstack/core session:e2e` (register ×2, deposit 20M + 30M, enable merge, merge to 1 UTXO, transfer 10M + 5M with memo by Solana address, withdraw 4M to a fresh public address).

## Localnet

- `zolana dev start` downloads programs, the account snapshot, the prover, and Photon from the pinned release, sha256-verified against a lockfile embedded in the CLI, and caches them in `~/.config/zolana/cache/<tag>/`.
- The release prover predates indexed proofs, so clients on a release localnet use `proofDataSource: "client"` (set in `core/config.ts`).
- Ports: RPC 8899, indexer 8784, prover 3001.

## Devnet endpoints (from zolana-examples)

- RPC `https://devnet.helius-rpc.com/?api-key=…`
- Indexer (Devnet-e Photon) `https://d34xe1hqb2ibg2.cloudfront.net`
- Prover (attested Nitro) `https://dd73hh473h6ha.cloudfront.net`, with PCRs pinned in `devnet-e-tee-policy.json` (vendored into core). The SDK's built-in default policy still pins the older Devnet-d enclave.

## Other useful SDK surface found

`isWalletRegistered`, `resolveShieldedRecipient`, `buildRegistrationTransaction`, `buildSetMergeEncryptionTransaction`, `createMerge` / `buildMergeTransaction`, `syncWallet` / `syncPersistedWallet` / `beginSyncSession` (ringd), `getPrivateTokenBalances`, `getPrivateTransactions`, `walletSnapshotCipher` (encrypted local persistence).
