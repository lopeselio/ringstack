# Payment proof (payee side)

**Status:** v1, implemented in `packages/core/src/payment-proof.ts`. Verified on localnet (`payroll e2e`, verifier page).

A payment proof lets the **recipient** of one output prove "I received this amount of this asset, with this memo, in this transaction", from their own wallet, without revealing anything else about the transaction. It complements the RingPay receipt (`spec/receipt.md`), which is issued by the **sender** and opens every output of a transaction.

| | Receipt (`ringrcpt1:`) | Payment proof (`ringproof1:`) |
|---|---|---|
| Made by | Sender | Recipient |
| Key disclosed | The transaction viewing key | One X25519 shared secret |
| Opens | Every output of the transaction | The recipient's output only |
| Typical use | Customer to merchant; treasury to accountant (audit bundle) | Employee to landlord, bank or lender |

## Why it works

Each confidential output carries a ciphertext addressed to its recipient. The ciphertext is `recipientViewingPk(33) ‖ AES-CTR(plaintext)`, keyed by HKDF-SHA256 over:

```
ikm  = X25519(txEphemeralSecret, recipientViewingPk) ‖ txViewingPublicKey ‖ recipientViewingPk
info = "TSPP/hpke/" ‖ "TSPP/tx" ‖ salt(16) ‖ u32be(slot)
okm  = HKDF(sha256, ikm, salt = none, info, 44)   → key = okm[0..32], nonce = okm[32..44]
CTR counter block = nonce ‖ 00 00 00 02
```

By Diffie-Hellman, the recipient computes the same shared secret as `X25519(recipientViewingSecret, txViewingPublicKey)`. Disclosing that 32-byte secret lets anyone derive the key for **this recipient's slot in this transaction**:

- Other outputs are addressed to other recipients' keys: a different shared secret.
- Every transaction uses a fresh ephemeral key, so the secret opens nothing in any other transaction.
- The secret does not reveal the recipient's viewing key.

The decrypted plaintext is the output's opening (asset id, amount, blinding, data). The verifier rebuilds the UTXO with the recipient's address and requires `utxo.hash(nullifierPk, treeId)` to equal the onchain leaf. A match proves the amount and asset, and that the secret is genuine. The same secret opens the output's **memo** message (paired by view tag as in `spec/receipt.md`, at ordinal `outputSlotCount + messageIndex`, where `outputSlotCount` counts every published output slot, padding included). The message bytes are onchain and bound by `external_data_hash`, so the memo is what the sender attached; it is not covered by the commitment. (Legacy payments carry the memo inside the output, which the commitment check then covers.)

Disclosing the blinding does not let anyone track the output: its nullifier needs the recipient's secret nullifier key.

## Wire format

`ringproof1:` followed by base64url (no padding) of 199 bytes:

| Bytes | Field |
|---|---|
| 1 | version (= 1) |
| 1 | cluster (0 localnet, 1 devnet, 2 mainnet) |
| 64 | transaction signature |
| 2 | output slot, u16 little-endian |
| 32 | shared secret |
| 99 | recipient shielded address (`ShieldedAddress.toBytes()`) |

## Verification

1. Fetch the transaction by signature (indexer `getShieldedTransactionsBySignature`); require the signature to match.
2. Take output `slot`. It must be a confidential (or ring-confidential) encrypted slot whose embedded recipient key equals the proof's address viewing key.
3. Decrypt with the derivation above; decode the confidential plaintext.
4. Resolve the asset id to a mint (SOL is built in; SPL ids come from the onchain asset registry).
5. Require `Utxo({ owner: address.signingPublicKey, asset, amount, blinding, data, ringProgramId? }).hash(address.nullifierPublicKey, treeId) == outputContext.hash`.
6. Display: amount, asset, memo, the payee's Solana address (the address's Ed25519 key). Optionally look the payee up in the user registry and show whether its current record carries the proof's viewing key.

## Implementation notes

- The SDK does not export the slot cipher, so `payment-proof.ts` reimplements it with `@noble/hashes` and `@noble/ciphers`. `provePayment` cross-checks the result against the SDK's own `ViewingKey.decryptUtxo` and refuses to issue a proof if they differ, so a protocol change fails loudly instead of producing proofs that do not verify.
- `provePayment` verifies every proof before returning it.
- Who paid is not part of the proof. The transaction's fee payer is public onchain; `payroll verify-proof` shows it when the RPC returns the transaction.
