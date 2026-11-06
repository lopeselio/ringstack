/**
 * Wraps the wallets a web page can reach so a request to sign the key-derivation
 * message is refused unless the user confirms it.
 *
 * This runs in the page's own JavaScript realm, so it stops dApps that ask
 * through the standard wallet APIs. A page that talks to a wallet's extension
 * directly, over the wallet's private messaging, goes around it. The complete
 * fix is a wallet calling `isTsppDerivationRequest` in its own signing path.
 */
import type { SolanaSignMessageInput, SolanaSignMessageOutput } from "@solana/wallet-standard-features";
import type { Wallet } from "@wallet-standard/base";
import { inspectSignRequest, toBytes, type DerivationForm } from "./detect.ts";

export interface DerivationRequest {
  /** The page asking. */
  readonly origin: string;
  readonly form: DerivationForm;
  readonly message: Uint8Array;
  /** The wallet's name, when the request came through Wallet Standard. */
  readonly wallet?: string;
}

export interface GuardOptions {
  /** The page origin, shown to the user and passed to `confirm`. */
  readonly origin: string;
  /** Asks the user. Returning true lets the request through. Without it, every request is refused. */
  readonly confirm?: (request: DerivationRequest) => boolean | Promise<boolean>;
  /** Called for every refused request. */
  readonly onRefused?: (request: DerivationRequest) => void;
}

export class DerivationRequestRefused extends Error {
  /** The "user rejected the request" code dApps already handle. */
  readonly code = 4001;
  constructor(readonly request: DerivationRequest) {
    super(`Refused to sign the Helius Privacy key-derivation message for ${request.origin}`);
    this.name = "DerivationRequestRefused";
  }
}

const SIGN_MESSAGE = "solana:signMessage";
const EVENTS = "standard:events";

type SignMessage = (...inputs: readonly SolanaSignMessageInput[]) => Promise<readonly SolanaSignMessageOutput[]>;
type Features = Wallet["features"];

/** Something with a `signMessage(message, ...)` and maybe a `request({ method, params })`. */
export interface InjectedProvider {
  signMessage?: (message: Uint8Array, ...rest: unknown[]) => Promise<unknown>;
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export interface Guard {
  /** A view of `wallet` whose `solana:signMessage` is guarded. Wrapping twice returns the same view. */
  wallet<W extends Wallet>(wallet: W): W;
  /** Guards `signMessage` and `request` on an injected provider in place. False when it could not. */
  provider(provider: unknown): boolean;
  /**
   * Checks one message and returns a private copy to hand to the wallet, or
   * rejects with `DerivationRequestRefused`. Signing the copy, not the
   * caller's buffer, stops a page swapping the bytes after the check.
   */
  vet(message: unknown, wallet?: string): Promise<unknown>;
}

const enc = new TextEncoder();
const keyOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function copyOf(message: unknown): Uint8Array | undefined {
  if (typeof message === "string") return enc.encode(message);
  try {
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message) || Array.isArray(message)) {
      return Uint8Array.from(toBytes(message as Uint8Array));
    }
  } catch {
    // Not bytes; the wallet will reject it on its own.
  }
  return undefined;
}

export function createGuard(options: GuardOptions): Guard {
  // Wallets often back their Wallet Standard wallet with their injected
  // provider, so one request can pass two guards. An approved message is let
  // through the inner one without asking again, while the outer call runs.
  const approved = new Map<string, number>();
  const views = new WeakMap<object, Wallet>();
  const isView = new WeakSet<object>();
  const featureViews = new WeakMap<object, Features>();
  const patched = new WeakSet<object>();

  async function vet(message: unknown, wallet?: string): Promise<unknown> {
    const copy = copyOf(message);
    if (copy === undefined) return message;
    const form = inspectSignRequest(copy);
    if (form === undefined || approved.has(keyOf(copy))) return copy;
    const request: DerivationRequest = { origin: options.origin, form, message: copy, ...(wallet ? { wallet } : {}) };
    let ok = false;
    try {
      ok = (await options.confirm?.(request)) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      options.onRefused?.(request);
      throw new DerivationRequestRefused(request);
    }
    return copy;
  }

  /** Runs `sign` with every approved derivation message marked for the inner guard. */
  async function withApproved<T>(messages: unknown[], sign: () => Promise<T>): Promise<T> {
    const keys = messages.flatMap((m) => (m instanceof Uint8Array && inspectSignRequest(m) ? [keyOf(m)] : []));
    for (const k of keys) approved.set(k, (approved.get(k) ?? 0) + 1);
    try {
      return await sign();
    } finally {
      for (const k of keys) {
        const n = approved.get(k)! - 1;
        if (n === 0) approved.delete(k);
        else approved.set(k, n);
      }
    }
  }

  function guardFeatures(features: Features, name: string): Features {
    const cached = featureViews.get(features);
    if (cached) return cached;
    const out: Record<string, unknown> = { ...features };
    const sign = features[SIGN_MESSAGE] as { signMessage: SignMessage } | undefined;
    if (sign && typeof sign.signMessage === "function") {
      const signMessage: SignMessage = async (...inputs) => {
        // Copy every message before the first await, so none can change while another is vetted.
        const copies = inputs.map((input) => ({ ...input, message: copyOf(input.message) ?? input.message }));
        const safe: SolanaSignMessageInput[] = [];
        for (const input of copies) safe.push({ ...input, message: (await vet(input.message, name)) as Uint8Array });
        return withApproved(
          safe.map((s) => s.message),
          () => sign.signMessage.apply(sign, safe),
        );
      };
      out[SIGN_MESSAGE] = { ...sign, signMessage };
    }
    // A change event can carry new features; hand listeners the guarded ones.
    const events = features[EVENTS] as { on: (event: string, listener: (p: Record<string, unknown>) => void) => () => void } | undefined;
    if (events && typeof events.on === "function") {
      out[EVENTS] = {
        ...events,
        on: (event: string, listener: (p: Record<string, unknown>) => void) =>
          events.on.call(events, event, (props) =>
            listener(props && "features" in props ? { ...props, features: guardFeatures(props["features"] as Features, name) } : props),
          ),
      };
    }
    const view = Object.freeze(out) as Features;
    featureViews.set(features, view);
    return view;
  }

  function wallet<W extends Wallet>(w: W): W {
    if (isView.has(w)) return w;
    const existing = views.get(w);
    if (existing) return existing as W;
    const view = new Proxy(w, {
      get(target, prop) {
        if (prop === "features") return guardFeatures(target.features, target.name);
        const value: unknown = Reflect.get(target, prop, target);
        // Wallet classes keep state in private fields, which need the real `this`.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    views.set(w, view);
    isView.add(view);
    return view;
  }

  function patch(target: object, provider: object): boolean {
    let done = false;
    const t = target as InjectedProvider;
    if (typeof t.signMessage === "function" && Object.hasOwn(target, "signMessage")) {
      const original = t.signMessage;
      done =
        define(target, "signMessage", async function (this: unknown, message: unknown, ...rest: unknown[]) {
          const safe = await vet(message);
          return withApproved([safe], () => original.call(this ?? provider, safe as Uint8Array, ...rest));
        }) || done;
    }
    if (typeof t.request === "function" && Object.hasOwn(target, "request")) {
      const original = t.request;
      done =
        define(target, "request", async function (this: unknown, args: { method: string; params?: unknown }) {
          const self = this ?? provider;
          const params = args?.params as { message?: unknown } | undefined;
          if (args?.method !== "signMessage" || params?.message === undefined) return original.call(self, args);
          const safe = await vet(params.message);
          return withApproved([safe], () => original.call(self, { ...args, params: { ...params, message: safe } }));
        }) || done;
    }
    return done;
  }

  function provider(p: unknown): boolean {
    if (p === null || typeof p !== "object" || patched.has(p)) return false;
    patched.add(p);
    // Patch the object and its prototypes, so the page cannot reach the
    // unguarded method through Object.getPrototypeOf.
    let ok = false;
    for (let o: object | null = p; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      ok = patch(o, p) || ok;
    }
    return ok;
  }

  return { wallet, provider, vet };
}

function define(target: object, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: true });
    return true;
  } catch {
    return false;
  }
}
