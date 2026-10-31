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
- Remaining: get `firstNullifier` after sending and exercise the decrypt path on localnet.

## Check 2: payroll batching: ✅ supported (high-level)

- `createMultiTransfer({ wallet, payer, asset, payments: [{recipient, amount}] })`, with each payment as its own output, in order.
- Limit: `MAX_TRANSFER_PAYMENTS = max(shape.outputs) - 1` = **15** payees per transaction (16 outputs minus change).
- The SDK picks the shape automatically; no need to force a variant.
- `TransferDestination = Address | ShieldedAddress`: plain addresses are resolved via the registry.
- `createSplit({ wallet, payer, asset, parts })` pre-splits treasury UTXOs so batches can run concurrently.

## Memos: ⚠️ low-level only

- High-level `createTransfer` / `createMultiTransfer` take **no memo**.
- `deposit` accepts `memo`. For transfers, memos go through `ProofOutputUtxo.withMemo(bytes)` (lower-level `ConfidentialTransfer` path).
- Memos are **not** in the UTXO commitment, but their ciphertext is bound by `external_data_hash`.
- Alternative: `withUtxoData(data, dataHash)` is committed, but SPP does not check `dataHash`, so readers must recompute it.
- **Impact:** RingPay order IDs and payroll memos need the lower-level builder. Prototype in M1.

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
