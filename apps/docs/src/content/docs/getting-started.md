---
title: Getting started
description: Install, run the unit tests, then run everything on devnet.
---

## Install

You need Node 24 and pnpm.

```bash
git clone https://github.com/lopeselio/ringstack && cd ringstack
nvm use
pnpm install
pnpm typecheck && pnpm test     # unit tests, no network needed
```

## Connect to devnet

Everything that touches the chain runs on Solana devnet.

1. Put a Helius API key in a `.env` file at the repo root. It is git-ignored.

   ```bash
   API_KEY=<your Helius key>
   ```

2. Fund a devnet keypair to pay for test wallets. The devnet RPC faucet is closed, so get test SOL from [faucet.solana.com](https://faucet.solana.com). A full test pass costs about 0.9 SOL.

3. Point the scripts at devnet:

   ```bash
   export ZOLANA_NETWORK=devnet
   export ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json   # your funded keypair
   ```

## Run the suites

```bash
pnpm --filter @ringstack/core e2e        # payments, receipts, memos, RingPay
pnpm --filter @ringstack/ringd e2e       # events, signed webhooks, auto-merge
pnpm --filter @ringstack/payroll e2e     # batches, resume, audit bundle, payee proofs
```

Each suite creates fresh wallets, funds them from your keypair, and checks every result against the chain.

## Try it by hand

- **Make a receipt and check it.** `pnpm --filter @ringstack/core receipt:demo` prints a verifier link. Start the verifier with `pnpm --filter @ringstack/verifier dev` and open the link.
- **Run the shop.** Follow the [checkout demo](../tools/checkout-demo/) to order a coffee, pay for it privately, and watch ringd mark it paid.
- **Pay a team.** Write a CSV and follow [private payroll](../tools/payroll/).

## Next

- [How it fits together](../overview/)
- [Running on devnet](../guides/devnet/): results and how the client reaches devnet
- [Privacy limits](../guides/privacy/)
