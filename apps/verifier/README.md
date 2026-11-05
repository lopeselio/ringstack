# Receipt verifier

A static page that checks a RingPay receipt (`ringrcpt1:…`, see [spec/receipt.md](../../spec/receipt.md)) or a payee's payment proof (`ringproof1:…`, see [spec/payment-proof.md](../../spec/payment-proof.md)). A proof shows the one output it opens, its memo, and whether the payee's registry record carries the proof's keys.

1. Decodes the receipt in the browser.
2. Fetches the transaction from the indexer by signature and decrypts its outputs with the receipt's transaction key.
3. Looks each output's viewing key up in the onchain user registry. Every output whose owner is found has its commitment recomputed, so its amount and asset show **Matches chain**. Outputs whose owner is unknown show **Not checked**; a mismatch shows **Doesn't match**.

What leaves the browser: the transaction signature (to the indexer) and registry/mint reads (to the Solana RPC). The receipt key never does: put the receipt after `#` in links, since fragments are not sent to servers.

## Links

```
https://<host>/#ringrcpt1:…                 check a receipt on load
https://<host>/?to=<address>#ringrcpt1:…    also mark and check the output paid to <address>
?rpc=<url>&indexer=<url>                     override the cluster's endpoints
```

Defaults: localnet uses the `zolana dev start` ports; devnet uses `api.devnet.solana.com` and the Helius devnet indexer. Mainnet receipts need explicit overrides.

## Develop

```bash
pnpm --filter @ringstack/verifier dev        # http://localhost:5173
pnpm --filter @ringstack/verifier build      # static files in apps/verifier/dist
```

To get a receipt to try, start localnet and run `pnpm --filter @ringstack/core receipt:demo`: a registered customer pays a registered merchant with a memo, and the script prints a verifier link.

The zolana SDK (with its hasher WASM) is about 1.4 MB gzipped. It is split into a separate chunk that loads on the first check.
