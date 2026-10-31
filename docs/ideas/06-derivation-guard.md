# 6. Derivation-signature phishing guard

**Status:** Backlog · **Type:** Small browser extension / wallet plugin

## Problem
The shielded keypair is derived from a signature over `"TSPP/derive/v1"`. Whoever obtains that signature can derive the viewing and nullifier keys and **decrypt all of a user's private activity**. The docs say wallets must reject third-party requests to sign it, but a malicious dApp can still ask.

## Solution
- Wallet Standard / injected-provider shim that intercepts `signMessage` and blocks any payload that is (or wraps) the TSPP derivation message (offchain message v0 envelope + raw form), with a loud warning.
- Reusable detection function (`isTsppDerivationRequest(bytes)`) that wallets can embed directly.
- Test vectors for all known encodings.

## Notes
Check upstream `feat/sign-with-wallet-adapter` before building, to align with whatever wallet integration Helius ships.
