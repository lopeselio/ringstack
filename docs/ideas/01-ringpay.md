# 1. RingPay: private payment requests + verifiable receipts

**Status:** Selected · **Type:** Client-only (TypeScript) · **Depends on:** [ringd](02-ringd.md) for merchant-side detection

## Problem

- Solana Pay links put a public `reference` pubkey in the transaction so merchants can find the payment. On a Ring, that reference **re-links** the private payment to a specific order, which defeats confidentiality.
- After a private payment, the payer cannot easily prove "I paid X of asset Y to Z" to a third party (merchant support, accountant, tax authority, dispute resolver) without handing over their whole viewing key.

The docs describe single-transaction disclosure via a transaction viewing key, but there is no tooling for it.

## Solution

### A. Payment request spec (`ringpay:` URI)

```
ringpay:<recipient-solana-address>?mint=<mint>&amount=<ui-amount>&order=<opaque-id>&label=<str>&message=<str>&ring=<ring-program-id?>
```

- `order` is **never** put onchain in the clear. The payer's wallet writes it into the **encrypted memo** of the private transfer.
- The merchant (via ringd) decrypts incoming outputs and matches on the memo.
- If the recipient isn't registered (`isWalletRegistered == false`), the wallet must **warn** that the payment would become a public withdrawal and require explicit confirmation, as the docs recommend.
- QR encoding is identical to Solana Pay for wallet familiarity.

### B. Receipts

- After paying, the payer exports a **receipt**: `{ signature, txViewingKey, cluster, ringProgramId }`, shareable as a link or QR code (`https://<verifier>/r#<base64url>`, with the key kept in the URL fragment so it never hits a server).
- **Verifier page** (static, client-side only):
  1. Fetch the tx via `getShieldedTransactionsBySignature`.
  2. Decrypt the single transaction with the disclosed key.
  3. Check that the decrypted output matches the onchain commitment (recompute the Poseidon UTXO hash).
  4. Display sender, recipient, asset, amount, memo, slot/time, finality.
- A receipt discloses **only that transaction**, not the payer's balance or history.

## Deliverables

- `@ringpay/core`: URI encode/parse, request validation, memo schema, receipt encode/decode/verify.
- `@ringpay/react`: QR display + "Pay privately" button for wallets that integrate zolana.
- `apps/verifier`: static receipt verifier (deployable anywhere).
- `apps/checkout-demo`: merchant demo wired to ringd.
- Spec doc: `spec/ringpay-uri.md`.

## Helius primitives used

Encrypted memo, transaction viewing key, `getShieldedTransactionsBySignature`, user registry lookup, Poseidon UTXO commitment.

## MVP (devnet)

1. URI spec + parser with tests.
2. Pay a request from a CLI wallet (zolana TS SDK) on localnet.
3. Export a receipt; verify it in the static page.
4. Merchant detects the order via ringd.

## Risks / open questions

- The transaction viewing key format and the SDK API for producing it need confirming in zolana source (`docs/spec.md`, ViewingKey / AES key derivation sections).
- The memo size limit determines how big `order` + metadata can be.
- Even with a confidential Ring, sender and recipient are public, so a merchant address that only receives store payments still reveals "this person shopped here". Document this clearly. Anonymous Rings fix it but need a Custom Ring.
