# Checkout demo

A café checkout that takes private payments end to end:

```
shop (Next.js) ──POST /orders──▶ checkout API (NestJS + Fastify) ──▶ ringpay: request + QR
customer wallet ── private transfer, memo "order:<id>" ──▶ merchant's shielded address
ringd (merchant's read-only keys) ── signed payment.received webhook ──▶ checkout API ──▶ order paid
shop polls the order ──▶ "Paid"; the customer's receipt opens in the verifier
```

| App | What it does |
|---|---|
| [`apps/checkout-demo`](.) | Next.js (App Router). Menu, order ticket with the QR code, live status. Talks only to its own origin: `/api/*` is rewritten to the API, and it never loads the zolana SDK. |
| [`apps/checkout-api`](../checkout-api) | NestJS on the Fastify adapter. Creates orders and their `ringpay:` requests, verifies ringd webhooks against the raw body, matches payments to orders by the order memo, and serves a test-network-only demo payer. |
| [`apps/ringd`](../ringd) | Watches the merchant with viewing + nullifier keys only and delivers the webhooks. |
| [`apps/verifier`](../verifier) | Opens the customer's receipt. |

## Run it on devnet

With `API_KEY` in the root `.env` and a funded devnet keypair (see [docs/devnet.md](../../docs/devnet.md)):

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json \
  pnpm --filter @ringstack/checkout-api demo:setup   # merchant + customer, .env, ringd config
```

Then, each in its own terminal:

```bash
pnpm --filter @ringstack/checkout-api start          # API on :4000
pnpm --filter @ringstack/checkout-api ringd          # ringd → API webhook
pnpm --filter @ringstack/checkout-demo dev           # shop on http://localhost:3000
pnpm --filter @ringstack/verifier dev                # receipts on :5173
```

Order something, then press **Pay as demo customer**. The demo customer pays the order's `ringpay:` request with `payRequest`. ringd picks the payment up within its 2-second poll and posts `payment.received` with `memo: "order:<id>"`, and the ticket switches to **Paid**. **Open the customer's receipt** shows the payment matched to the chain in the verifier.

`demo:setup` writes `apps/checkout-api/.env` and `apps/checkout-api/.demo/` (keys and databases, git-ignored). Rerun it with `--force` to start fresh. On devnet ringd picks a payment up within a few seconds.

## How an order gets paid

- `POST /orders {item}` creates an 8-character order id and a request: `ringpay:<merchant>?amount=0.0125&order=<id>&label=Corner%20Café&message=Flat%20white&cluster=devnet`.
- `POST /webhooks/ringd` verifies the signature (`@ringstack/ringd-client`), ignores anything but `payment.received`, reads the order from the memo, and checks the asset. The payment is stored under ringd's `ringd-id`, so a redelivered webhook changes nothing.
- An order is `paid` once its matched payments cover the price. Less than the price shows as `underpaid` until the rest arrives.

## Implementation notes

- **NestJS without decorator metadata.** The repo runs TypeScript through tsx/esbuild, which does not emit `design:paramtypes`, so every constructor dependency has an explicit `@Inject(token)` (`src/tokens.ts`). With `tsc` or SWC it would work either way.
- **Raw body.** The app is created with `rawBody: true` and the webhook controller verifies `req.rawBody`, the exact bytes ringd signed.
- **The demo payer holds a spending key.** `DEMO_CUSTOMER_KEYPAIR` is refused on anything but localnet or devnet. A real shop has no such endpoint: the customer pays from their own wallet.
