# Derivation guard extension

A small browser extension that stops websites from getting the wallet signature that unlocks your Helius Privacy activity, unless you confirm.

A Helius Privacy app sets up your private account by asking your Solana wallet to sign one fixed message. Whoever has that signature can read your private balance and every private payment you have sent or received. A phishing site can ask for the same signature. Most wallets show it as an ordinary "sign message" prompt, so it is easy to approve.

With the extension installed, a request for that message opens a browser dialog first. It names the site and the wallet and explains what the signature unlocks. Press Cancel and the site gets a "user rejected" error; nothing is signed. Every other request goes to your wallet as usual.

It runs [`@ringstack/derivation-guard`](../../packages/derivation-guard) in every page and frame, before the page's own scripts. It needs no permissions and sends nothing anywhere.

## Install (unpacked)

```bash
pnpm --filter @ringstack/derivation-guard-extension build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and pick `apps/derivation-guard-extension/dist`.

This needs Chrome, Edge, Brave or another Chromium browser, version 111 or later.

The script in `dist/guard.js` is not minified, so you can read exactly what runs in your pages.

## When to press OK

Only when you opened a Helius Privacy app you trust yourself and are setting up your private account in it. A site that asks out of nowhere, during a mint, a sign-in or a "verify your wallet" step, is trying to read your private payments.

## Limits

It covers wallets that sites reach through Wallet Standard or `window.solana`-style providers. A site written against one wallet's private messaging can go around it. So can a wallet injected by another extension before this one runs. A wallet that checks for this message itself, with `isTsppDerivationRequest`, protects you completely; this extension is a second layer until wallets do.

Cross-origin frames cannot open dialogs, so a request from one is refused without asking.

## Tests

```bash
pnpm --filter @ringstack/derivation-guard-extension test
```

This builds `dist/` and runs the built script against a stub page. It checks the refusal and its console warning, the dialog text, and a confirmed request through a Wallet Standard wallet.
