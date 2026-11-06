import { ed25519DerivationMessage } from "@heliuslabs/spr/keypair";
import type { SolanaSignMessageFeature, SolanaSignMessageInput } from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { StandardEventsFeature, StandardEventsListeners } from "@wallet-standard/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivationRequestRefused, type DerivationRequest, type GuardOptions } from "../src/guard.ts";
import { installPageGuard } from "../src/page.ts";

type Bytes32 = Parameters<typeof ed25519DerivationMessage>[0];
const DERIVE = ed25519DerivationMessage(new Uint8Array(32).fill(9) as Bytes32);
const HELLO = new TextEncoder().encode("Sign in to example.com");
const ORIGIN = "https://shop.example";

const account: WalletAccount = {
  address: "11111111111111111111111111111111",
  publicKey: new Uint8Array(32),
  chains: ["solana:devnet"],
  features: ["solana:signMessage"],
};

/** A Wallet Standard wallet that keeps state in a private field, as real ones do. */
class FakeWallet implements Wallet {
  readonly #signed: Uint8Array[] = [];
  readonly #listeners: StandardEventsListeners["change"][] = [];
  readonly version = "1.0.0" as const;
  readonly name = "Fake Wallet";
  readonly icon = "data:image/svg+xml;base64,AA==" as const;
  readonly chains = ["solana:devnet"] as const;
  readonly accounts = [account];
  constructor(private readonly backing?: { signMessage(m: Uint8Array): Promise<unknown> }) {}
  get signed() {
    return this.#signed;
  }
  get features(): SolanaSignMessageFeature & StandardEventsFeature {
    return {
      "solana:signMessage": {
        version: "1.1.0",
        signMessage: async (...inputs: readonly SolanaSignMessageInput[]) => {
          const out = [];
          for (const { message } of inputs) {
            if (this.backing) await this.backing.signMessage(message);
            this.#signed.push(Uint8Array.from(message));
            out.push({ signedMessage: message, signature: new Uint8Array(64) });
          }
          return out;
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (_event, listener) => {
          this.#listeners.push(listener);
          return () => {};
        },
      },
    };
  }
  emitChange() {
    for (const l of this.#listeners) l({ features: this.features });
  }
}

/**
 * A legacy provider with its methods on a prototype. The guard patches the
 * prototype for good, so each test gets its own class.
 */
const makeProvider = () => new (class FakeProvider {
  readonly signed: Uint8Array[] = [];
  async signMessage(message: Uint8Array) {
    this.signed.push(Uint8Array.from(message));
    return { signature: new Uint8Array(64) };
  }
  async request({ method, params }: { method: string; params?: { message?: Uint8Array } }) {
    if (method === "signMessage") return this.signMessage(params!.message!);
    return `ok:${method}`;
  }
})();
type FakeProvider = ReturnType<typeof makeProvider>;

type Win = EventTarget & Record<string, unknown>;
let win: Win;

async function loadStandard() {
  vi.resetModules();
  const [{ getWallets }, { registerWallet }] = await Promise.all([import("@wallet-standard/app"), import("@wallet-standard/wallet")]);
  return { getWallets, registerWallet };
}

const signWith = (w: Wallet, message: Uint8Array) =>
  (w.features as SolanaSignMessageFeature)["solana:signMessage"].signMessage({ account, message });

function install(opts: Partial<GuardOptions> = {}) {
  return installPageGuard(win as unknown as Parameters<typeof installPageGuard>[0], { origin: ORIGIN, ...opts });
}

beforeEach(() => {
  win = new EventTarget() as Win;
  vi.stubGlobal("window", win);
});
afterEach(() => vi.unstubAllGlobals());

describe("Wallet Standard", () => {
  it.each(["wallet first", "app first"])("guards wallets when the %s loads", async (order) => {
    install();
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    let wallets;
    if (order === "wallet first") {
      registerWallet(raw);
      wallets = getWallets();
    } else {
      wallets = getWallets();
      registerWallet(raw);
    }
    const [w] = wallets.get();
    expect(w).toBeDefined();
    expect(w).not.toBe(raw);
    expect(w!.name).toBe("Fake Wallet");
    await signWith(w!, HELLO);
    const refused = await signWith(w!, DERIVE).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DerivationRequestRefused);
    expect((refused as DerivationRequestRefused).code).toBe(4001);
    expect(raw.signed).toEqual([HELLO]);
  });

  it("registers each wallet once even though both events deliver it", async () => {
    install();
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    const wallets = getWallets();
    registerWallet(raw);
    registerWallet(raw);
    expect(wallets.get()).toHaveLength(1);
  });

  it("hands a page that collects wallets itself only guarded ones", async () => {
    install();
    const { registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    const collected: Wallet[] = [];
    // The page listens for announcements and also asks wallets to register.
    win.addEventListener("wallet-standard:register-wallet", (e) =>
      (e as CustomEvent).detail({ register: (...w: Wallet[]) => (collected.push(...w), () => {}) }),
    );
    registerWallet(raw);
    win.dispatchEvent(
      new CustomEvent("wallet-standard:app-ready", { detail: { register: (...w: Wallet[]) => (collected.push(...w), () => {}) } }),
    );
    expect(collected).toHaveLength(2);
    for (const w of collected) await expect(signWith(w, DERIVE)).rejects.toBeInstanceOf(DerivationRequestRefused);
    expect(raw.signed).toEqual([]);
  });

  it("asks the user and signs when they confirm", async () => {
    const seen: DerivationRequest[] = [];
    install({ confirm: (r) => (seen.push(r), true) });
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    registerWallet(raw);
    await signWith(getWallets().get()[0]!, DERIVE);
    expect(raw.signed).toEqual([DERIVE]);
    expect(seen).toMatchObject([{ origin: ORIGIN, form: "offchain", wallet: "Fake Wallet" }]);
  });

  it("refuses when the prompt throws, and reports it", async () => {
    const refused: DerivationRequest[] = [];
    install({
      confirm: () => {
        throw new Error("no UI");
      },
      onRefused: (r) => refused.push(r),
    });
    const { getWallets, registerWallet } = await loadStandard();
    registerWallet(new FakeWallet());
    await expect(signWith(getWallets().get()[0]!, DERIVE)).rejects.toBeInstanceOf(DerivationRequestRefused);
    expect(refused).toHaveLength(1);
  });

  it("signs a copy, so the page cannot swap the bytes after the check", async () => {
    install();
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    registerWallet(raw);
    const message = new Uint8Array(DERIVE.length).fill(0x41);
    const pending = signWith(getWallets().get()[0]!, message);
    message.set(DERIVE);
    await pending;
    expect(raw.signed).toEqual([new Uint8Array(DERIVE.length).fill(0x41)]);
  });

  it("copies every input before vetting any, in a multi-message request", async () => {
    install({ confirm: async () => true });
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    registerWallet(raw);
    const second = new Uint8Array(DERIVE.length).fill(0x42);
    const sign = (getWallets().get()[0]!.features as SolanaSignMessageFeature)["solana:signMessage"];
    const pending = sign.signMessage({ account, message: DERIVE }, { account, message: second });
    await Promise.resolve();
    second.set(DERIVE);
    await pending;
    expect(raw.signed).toEqual([DERIVE, new Uint8Array(DERIVE.length).fill(0x42)]);
  });

  it("guards features delivered by a change event", async () => {
    install();
    const { getWallets, registerWallet } = await loadStandard();
    const raw = new FakeWallet();
    registerWallet(raw);
    const w = getWallets().get()[0]!;
    let features: Wallet["features"] | undefined;
    (w.features as StandardEventsFeature)["standard:events"].on("change", (p) => (features = p.features));
    raw.emitChange();
    const sign = (features as SolanaSignMessageFeature)["solana:signMessage"];
    await expect(sign.signMessage({ account, message: DERIVE })).rejects.toBeInstanceOf(DerivationRequestRefused);
  });

  it("asks once when the wallet is backed by its own injected provider", async () => {
    const provider = makeProvider();
    win["solana"] = provider;
    const confirm = vi.fn(() => true);
    install({ confirm });
    const { getWallets, registerWallet } = await loadStandard();
    registerWallet(new FakeWallet(provider));
    await signWith(getWallets().get()[0]!, DERIVE);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(provider.signed).toEqual([DERIVE]);
  });
});

describe("injected providers", () => {
  it("patches a provider assigned after install", async () => {
    install();
    const p = makeProvider();
    win["solana"] = p;
    await expect(p.signMessage(DERIVE)).rejects.toBeInstanceOf(DerivationRequestRefused);
    await p.signMessage(HELLO);
    expect(p.signed).toEqual([HELLO]);
  });

  it("patches a nested provider that already exists, prototype included", async () => {
    const p = makeProvider();
    win["phantom"] = { solana: p };
    install();
    const proto = Object.getPrototypeOf(p) as FakeProvider;
    await expect(proto.signMessage.call(p, DERIVE)).rejects.toBeInstanceOf(DerivationRequestRefused);
    await expect(p.request({ method: "signMessage", params: { message: DERIVE } })).rejects.toBeInstanceOf(
      DerivationRequestRefused,
    );
    expect(await p.request({ method: "connect" })).toBe("ok:connect");
    expect(p.signed).toEqual([]);
  });

  it("refuses a derivation message passed as text", async () => {
    install();
    const p = makeProvider();
    win["solflare"] = p;
    await expect(p.signMessage("TSPP/derive/v1" as unknown as Uint8Array)).rejects.toBeInstanceOf(DerivationRequestRefused);
  });

  it("patches providers attached to an existing object by the load sweep", async () => {
    win["phantom"] = {};
    install();
    const p = makeProvider();
    (win["phantom"] as Record<string, unknown>)["solana"] = p;
    win.dispatchEvent(new Event("DOMContentLoaded"));
    await expect(p.signMessage(DERIVE)).rejects.toBeInstanceOf(DerivationRequestRefused);
  });
});
