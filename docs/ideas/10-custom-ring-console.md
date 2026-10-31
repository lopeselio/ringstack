# 10. Custom Ring policy templates & auditor console

**Status:** Backlog · **Type:** ZK program + web app (hardest)

## Problem
Custom Rings (whitelist, blocklist, freeze, co-sign, permanent delegate, auditor, pause) are the enterprise path, but there is no public Custom Ring program example, and auditors have no open tooling.

## Solution
- **Policy templates:** open Custom Ring programs for common policies (Merkle-root allowlist, per-tx limit with co-signer above threshold, freeze/thaw).
- **Auditor console:** web app for the auditor-key holder that decrypts ring activity, filters, flags anomalies (structuring, velocity), and exports reports (CSV/PDF).

## Primitives
Custom Ring program + policy proofs, Ring RPC (`https://d24brah9h1i4q9.cloudfront.net` beta), auditor key.

## Open questions
- Policy-proof circuit interface isn't documented publicly. Needs zolana source deep-dive or Helius partnership.
- Depends on Helius-run Ring RPC and relayer for anonymous rings.
