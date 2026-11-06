/**
 * Installs the guard in a page before any page script runs (a browser
 * extension's MAIN-world content script at `document_start`).
 *
 * Wallet Standard: wallets and apps find each other through two window events.
 * The guard catches both first, stops them, and dispatches them again with the
 * wallets wrapped, so every party, the page included, sees guarded wallets.
 *
 * Injected providers (`window.solana`, `window.phantom.solana`, ...): patched
 * in place when they appear and again once the page has loaded.
 */
import type { Wallet } from "@wallet-standard/base";
import { createGuard, type Guard, type GuardOptions } from "./guard.ts";

const REGISTER_WALLET = "wallet-standard:register-wallet";
const APP_READY = "wallet-standard:app-ready";

/** Globals where Solana wallets inject a provider. */
export const INJECTED_PROVIDERS: readonly (readonly string[])[] = [
  ["solana"],
  ["phantom", "solana"],
  ["solflare"],
  ["backpack"],
  ["backpack", "solana"],
  ["glowSolana"],
];

type Api = { register: (...wallets: Wallet[]) => () => void };
type PageWindow = Pick<Window, "addEventListener" | "dispatchEvent"> & Record<string, unknown>;

export function installPageGuard(win: PageWindow, options: GuardOptions): Guard {
  const guard = createGuard(options);
  const redispatched = new WeakSet<Event>();
  // Wallet Standard's events override the stop methods to throw, and some
  // runtimes (Node) implement stopImmediatePropagation by calling
  // this.stopPropagation(), so shadow both with the originals for the call.
  const { stopImmediatePropagation, stopPropagation } = Event.prototype;
  const stop = (event: Event) => {
    try {
      Object.defineProperty(event, "stopPropagation", { value: stopPropagation, configurable: true });
      stopImmediatePropagation.call(event);
    } finally {
      delete (event as { stopPropagation?: unknown }).stopPropagation;
    }
  };
  const wrapApi = (api: Api): Api =>
    Object.freeze({ register: (...wallets: Wallet[]) => api.register(...wallets.map((w) => guard.wallet(w))) });

  const intercept = (type: string, rewrap: (detail: unknown) => unknown) =>
    win.addEventListener(
      type,
      (event) => {
        if (redispatched.has(event)) return;
        stop(event);
        const again = new CustomEvent(type, { detail: rewrap((event as CustomEvent).detail) });
        redispatched.add(again);
        win.dispatchEvent(again);
      },
      { capture: true },
    );

  // A wallet announcing itself: whoever answers gets a wrapping register.
  intercept(REGISTER_WALLET, (callback) => (api: Api) => (callback as (api: Api) => void)(wrapApi(api)));
  // An app (or the page) asking wallets to register: they register wrapped.
  intercept(APP_READY, (api) => wrapApi(api as Api));

  const sweep = () => {
    for (const path of INJECTED_PROVIDERS) {
      let o: unknown = win;
      for (const key of path) o = o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
      if (o) guard.provider(o);
    }
  };
  // Catch a top-level provider the moment a wallet assigns it.
  for (const name of new Set(INJECTED_PROVIDERS.map((p) => p[0]!))) {
    let value = win[name];
    try {
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v) => {
          value = v;
          sweep();
        },
      });
    } catch {
      // Already defined as fixed; the sweep below still patches it.
    }
  }
  sweep();
  win.addEventListener("DOMContentLoaded", sweep);
  win.addEventListener("load", sweep);
  return guard;
}
