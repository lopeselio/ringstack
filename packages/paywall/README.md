# @ringstack/paywall

Pay-per-call APIs with private payments: an x402-style **HTTP 402** flow where the agent pays with a RingPay private transfer.

```
agent                                   API (paywall)
  │  GET /v1/forecast                      │
  │ ─────────────────────────────────────▶ │
  │  402  RingPay-Request: ringpay:…?order=x402-…
  │ ◀───────────────────────────────────── │
  │  private transfer, memo "order:x402-…" │
  │  GET /v1/forecast                      │
  │  RingPay-Payment: <tx signature>       │
  │ ─────────────────────────────────────▶ │  decrypt own output, check amount,
  │  200  RingPay-Settled: <signature>     │  asset, nonce, resource; consume nonce
  │ ◀───────────────────────────────────── │
```

## Why a signature, not a receipt

The API is the payee, so it decrypts **its own output** with its read-only viewing key ([payment proof](../../spec/payment-proof.md) machinery). The agent sends only the transaction signature. A receipt would also have revealed the agent's change, which is its remaining balance, to every API it pays.

## Server

```ts
import { Paywall, paywalled } from "@ringstack/paywall";
import { readKeyFile } from "@ringstack/core";

const keys = await readKeyFile("vendor.ringd-key.json"); // viewing + nullifier keys only
const paywall = new Paywall({
  client,                                    // zolana client (indexer access)
  vendor: { address: keys.address, viewingSecret: keys.viewingSecret },
  recipient: vendorSolanaAddress,            // registered for private payments
  cluster: "devnet",
  label: "Forecast API",
});

// Fetch-API handlers (Hono, Next.js route handlers, Bun, workers):
export const GET = paywalled(paywall, "0.0005", () => Response.json(data));

// Express-style: app.get("/x", paywallMiddleware(paywall, "0.0005"), handler)
// Anything else: const decision = await paywall.decide(header, resourceOf(method, url), "0.0005")
```

A payment is accepted only if:

- the vendor's output commitment matches the chain,
- the asset is right and the amount covers the price,
- the memo is `order:<nonce>` for an outstanding, unexpired challenge (10 minutes by default),
- the challenge was for the same resource (`METHOD /path`; the query is ignored).

The nonce is consumed on the first redemption attempt, so a signature buys exactly one call. A payment sent to the wrong route is consumed and refused. Nonces live in a `MemoryNonceStore`; use a shared `NonceStore` across instances.

## Client

```ts
import { SpendLedger, paidFetch } from "@ringstack/paywall";

const { response, payment } = await paidFetch("https://api.example.com/v1/forecast?city=Lisbon", {}, {
  session,                                   // RingSession with a private balance
  cluster: "devnet",
  policy: { maxPerCall: 1_000_000n, dailyBudget: 10_000_000n, allowHosts: ["api.example.com"] },
  ledger: new SpendLedger("spend.json"),
});
```

The policy is checked **before** paying: host and recipient allow-lists, SOL only, per-call limit, and the daily budget from the ledger. A refusal throws `SpendRefused` with a code and moves no funds. The [agent MCP server](../../apps/agent-mcp) wraps this for AI agents.

## Limits

- **Latency:** a payment is a proof plus a confirmation, so a few seconds. Fine for expensive calls; for many cheap calls, prepay (for example, one payment for a block of calls) instead of paying per request.
- **Bearer signature:** whoever presents a paid signature first gets the call. The signature is only sent to the API, over HTTPS.
- **Linkability:** amounts and order ids are encrypted, but the agent ↔ API addresses are visible onchain ([privacy limits](../../docs/privacy.md)).
- **Memo payments:** the API's received payments carry memos, so until [zolana#543](https://github.com/helius-labs/zolana/issues/543) is fixed, spend them with `RingSession` (or merge them with ringd).
