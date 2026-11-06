# derivation-guard

Stops a website from getting the wallet signature that unlocks someone's Helius Privacy activity.

The SDK derives a user's viewing and nullifier keys from their wallet's signature over one fixed message, `ed25519DerivationMessage(publicKey)`. That is a Solana off-chain message whose payload is `TSPP/derive/v1`. The signature is a master key for reading: anyone who has it can decrypt the user's private balance and every private payment they have sent or received. A phishing site only has to get the wallet to sign that message once.

The SDK already refuses to sign it with its own `SigningKey` (`isDerivationInput`). Browser wallets don't use that path, so this package covers it:

- `isTsppDerivationRequest(bytes)`: a detector with no dependencies that wallets can copy into their signing path.
- `installPageGuard(window, options)`: wraps every wallet a page can reach, so a derivation request is refused unless the user confirms it. The [browser extension](../../apps/derivation-guard-extension) runs it on every site.
- [Test vectors](test-vectors/derivation-requests.json) for the request shapes a wallet sees.

## For wallets: the detector

```ts
import { isTsppDerivationRequest } from "@ringstack/derivation-guard/detect";

if (isTsppDerivationRequest(message) && !isTrustedOrigin(origin)) {
  throw userRejected("This site is asking for the signature that unlocks your Helius Privacy account.");
}
```

`src/detect.ts` has no imports. It refuses:

| Form | Example | SDK refuses it too |
|---|---|---|
| `bare` | `TSPP/derive/v1`, or any later `TSPP/derive/...` | Yes |
| `offchain` | The canonical off-chain message. Also the payload under another domain, in UTF-8 format, with extra signers, with a wrong declared length, or in an off-chain version other than 0 | Yes for v0 with a correct length |
| `tspp-domain` | Any off-chain message under the TSPP application domain, `sha256("TSPP/derive/v1")` | No |

It refuses everything the SDK's `isDerivationInput` refuses; a property test checks this. It also refuses the few extra shapes above. A signature over those could not seed today's keys, but no honest app asks for them. It allows ordinary text, including a Sign-In With Solana message that mentions `TSPP/derive/v1`, because a signature over that text could not seed anything.

The vectors list each request as hex with `refuse` (what a wallet should do) and `sdkRefuses` (what the SDK says). They are generated from the SDK's own `ed25519DerivationMessage` and checked against hand-written expectations:

```bash
pnpm --filter @ringstack/derivation-guard vectors
```

## For pages: the guard

```ts
import { installPageGuard } from "@ringstack/derivation-guard";

installPageGuard(window, {
  origin: location.origin,
  confirm: (request) => window.confirm(`${request.origin} wants the signature that unlocks your private payments. Allow?`),
  onRefused: (request) => console.warn("refused", request.form),
});
```

It must run before any page script:

- **Wallet Standard:** it catches the `wallet-standard:register-wallet` and `wallet-standard:app-ready` events first and dispatches them again with each wallet wrapped. Every party sees the guarded wallet, including a page that collects wallets itself. Only `solana:signMessage` changes, and features delivered by `standard:events` change events are wrapped too.
- **Injected providers:** `window.solana`, `window.phantom.solana`, `window.solflare`, `window.backpack` and `window.glowSolana`. It patches `signMessage` and `request({ method: "signMessage" })` on the provider and on its prototypes. It does this when a wallet assigns the provider, and again on `DOMContentLoaded` and `load`.

A refused request rejects with `DerivationRequestRefused`, whose `code` is 4001, the usual "user rejected" code. Without a `confirm`, every derivation request is refused.

Two details matter for safety:

- **The wallet signs a copy of the message.** The guard copies every message before its first `await`, so a page can't pass harmless bytes and swap in the derivation message after the check.
- **An approved request is asked once.** Many wallets back their Wallet Standard wallet with their own injected provider, so one request can pass both guards. While an approved request is in flight, the inner guard lets that exact message through without asking again.

## Limits

The guard runs in the page's own JavaScript, so it only stops pages that go through the standard wallet APIs. A page written against one wallet's private messaging (for example, posting to the wallet extension's content script directly) goes around it. Another extension that injects its own wallet ahead of this one can also escape the wrapping. The complete fix is in the wallet itself: call `isTsppDerivationRequest` where the wallet signs, and show its own warning. The page guard is a second layer until wallets do that.

## Tests

```bash
pnpm --filter @ringstack/derivation-guard test
```

The detector tests run the vectors and check that the constants match the SDK's. A property test mutates the canonical and bare messages thousands of times and checks the detector refuses everything the SDK refuses. The guard tests run the real `@wallet-standard/app` and `@wallet-standard/wallet` handshake: wallets loading before and after the app, a page collecting wallets itself, a swapped message, a change event, a wallet backed by its provider, prototype access and `request()`.
