/**
 * Runs in every page before the page's own scripts (MAIN world, document_start)
 * and wraps the wallets the page can reach. A request to sign the Helius
 * Privacy key-derivation message gets a native confirm dialog; anything else
 * goes to the wallet untouched.
 */
import { installPageGuard, type DerivationRequest } from "@ringstack/derivation-guard";

// Keep our own reference, taken before any page script can replace it.
const ask = window.confirm.bind(window);
const warn = console.warn.bind(console);
const origin = location.origin === "null" ? "This page" : location.origin;

function prompt(request: DerivationRequest): string {
  const via = request.wallet ? ` through ${request.wallet}` : "";
  return [
    `${request.origin} is asking your wallet${via} to sign the Helius Privacy key-derivation message.`,
    "",
    "That signature unlocks your private balance and every private payment you have sent or received. Anyone who gets it can read them all.",
    "",
    "Press OK only if you opened a Helius Privacy app you trust and are setting up your private account in it. Otherwise press Cancel.",
  ].join("\n");
}

installPageGuard(window as unknown as Parameters<typeof installPageGuard>[0], {
  origin,
  // Cross-origin iframes cannot open dialogs; confirm returns false there, so
  // the request is refused.
  confirm: (request) => ask(prompt(request)),
  onRefused: (request) =>
    warn(`[derivation guard] Refused a key-derivation signing request from ${request.origin} (${request.form}).`),
});
