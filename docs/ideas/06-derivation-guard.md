# 6. Derivation-signature phishing guard

**Status:** Built ([`@ringstack/derivation-guard`](../../packages/derivation-guard), [extension](../../apps/derivation-guard-extension)) · **Type:** Small browser extension / wallet plugin

## Problem
The shielded keypair is derived from a signature over `"TSPP/derive/v1"`. Whoever obtains that signature can derive the viewing and nullifier keys and **decrypt all of a user's private activity**. The docs say wallets must reject third-party requests to sign it, but a malicious dApp can still ask.

## Solution
- Wallet Standard / injected-provider shim that intercepts `signMessage` and blocks any payload that is (or wraps) the TSPP derivation message (offchain message v0 envelope + raw form), with a loud warning.
- Reusable detection function (`isTsppDerivationRequest(bytes)`) that wallets can embed directly.
- Test vectors for all known encodings.

## Notes
Upstream (0.8.0-alpha) ships `isDerivationInput` and refuses derivation input in the SDK's own `SigningKey.sign`, but nothing guards a browser wallet a dApp asks directly. The detector here refuses everything `isDerivationInput` refuses (property-tested) plus a few envelopes it lets through, and the page guard covers Wallet Standard and injected providers. It runs in the page, so a site using a wallet's private messaging goes around it; the full fix is wallets calling the detector in their own signing path.
