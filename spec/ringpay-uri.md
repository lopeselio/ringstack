# RingPay payment request URI

**Status:** v1 draft, implemented in `packages/core/src/ringpay.ts` (parser, encoder, memo schema) and `ringpay-pay.ts` (paying a request). Verified on localnet.

A `ringpay:` URI asks a payer's wallet to make a **private** transfer on Helius Privacy (zolana). It follows [Solana Pay transfer requests](https://docs.solanapay.com/spec) where it can, so wallets and QR flows feel familiar. It differs in one important way: there is **no public `reference`**. Solana Pay puts a public reference key in the transaction so the merchant can find it. On a private pool that would re-link the payment to the order. Instead, the order id travels in the transfer's **encrypted memo**, which only the recipient (and receipt holders) can read.

## Syntax

```
ringpay:<recipient>?amount=<amount>&mint=<mint>&order=<order>&label=<label>&message=<message>&cluster=<cluster>
```

- `<recipient>`: required. The base58 Solana address the merchant registered in the zolana user registry. The wallet resolves it to a shielded address through the registry.
- Parameters are `key=value` pairs separated by `&`. Keys are case-sensitive. Values are percent-encoded (`encodeURIComponent`); `+` is a literal plus sign, not a space.
- A key that appears twice makes the URI invalid.

| Parameter | Required | Value |
|---|---|---|
| `amount` | no | Amount in UI units of the mint: a non-negative decimal such as `1`, `0.0125`. Digits before any `.`, no sign or exponent, at most as many fraction digits as the mint has decimals. Must be greater than zero. If absent, the wallet asks the payer. |
| `mint` | no | Mint address of the asset. Absent means SOL. |
| `order` | no | Opaque order id, 1–26 characters from `A–Z a–z 0–9 . _ ~ -`. Carried in the encrypted memo (below). Never displayed as anything but an order reference. |
| `label` | no | Who is asking (merchant name), up to 64 characters. Display only, never sent onchain. |
| `message` | no | Description (for example, the item), up to 256 characters. Display only, never sent onchain. |
| `cluster` | no | `mainnet`, `devnet` or `localnet`. Absent means `mainnet`. A wallet on another cluster must refuse the request. |
| `req-*` | — | Any parameter starting with `req-` is **required to be understood**: a wallet that does not know it must refuse the request. This leaves room for future extensions. |
| other | — | Unknown parameters without the `req-` prefix are ignored. |

## Memo schema

The memo is the fixed-width encrypted memo from `core/src/memo.ts`: 32 bytes of UTF-8, zero-padded. For a request with `order`, the payer's wallet attaches this memo to the recipient's output, as an encrypted transaction message carrying that output's view tag:

```
order:<order>
```

The longest order id is therefore 32 − 6 = 26 bytes. A memo that does not start with `order:` is free text and is not an order reference. Future memo kinds use other `<kind>:` prefixes.

The merchant matches payments to orders by reading the memo of each received output: ringd delivers it as `memo` in `payment.received` webhooks. (Payments made before memos moved to messages carry the memo inside the output instead; readers accept both.)

## Paying a request (wallet rules)

1. Parse the URI. Refuse on any error, on an unknown `req-*` parameter, or when `cluster` does not match the wallet's cluster.
2. Look up `<recipient>` in the user registry. **If it is not registered, refuse.** The payment cannot be private: the only way to pay an unregistered address is a public withdrawal, which would reveal the payment. A wallet may offer that as a separate, explicitly confirmed action, but never as a silent fallback.
3. Convert `amount` to base units with the mint's decimals.
4. Show the payer the label, message, amount, asset and recipient, and get confirmation.
5. Send a private transfer of that amount to the recipient's shielded address, with the order memo on the recipient's output.
6. Offer the payer a receipt (`spec/receipt.md`) for the transaction.

`payRequest` in `core/src/ringpay-pay.ts` implements steps 1–3, 5 and 6. Step 4 is up to the calling app.

## Privacy notes

- The URI itself is not private. Anyone who sees the QR code or link learns the merchant, amount and order id. Share it the way you would share an invoice.
- Onchain, the transfer hides the amount, asset and memo. Sender and recipient addresses are visible as transaction participants, so a merchant address used only for one shop still reveals "this payer paid this shop". Anonymous custom rings would be needed to hide that.
- Observers can tell that an output has a memo (a fixed-width message with that output's view tag), though not its content.
- Matching on exact amounts is not needed: the order id in the memo identifies the payment.

## Examples

```
ringpay:GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD?amount=0.0125&order=1042&label=Corner%20Caf%C3%A9&message=Flat%20white&cluster=devnet
ringpay:GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD?amount=25&mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&order=inv-2026-11-0007
ringpay:GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD?label=Tips
```
