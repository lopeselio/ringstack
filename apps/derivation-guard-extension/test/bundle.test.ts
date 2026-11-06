// Runs the built content script (dist/guard.js) against a stub page, the way
// the browser would: before any page script, with window as the global.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../dist/guard.js", import.meta.url), "utf8");
const DERIVE = new TextEncoder().encode("TSPP/derive/v1");
const HELLO = new TextEncoder().encode("hello");

function page(answer: boolean) {
  const prompts: string[] = [];
  const warnings: string[] = [];
  const target = new EventTarget();
  const win = Object.assign(target, {
    confirm: (text: string) => (prompts.push(text), answer),
    location: { origin: "https://dapp.example" },
    console: { warn: (m: string) => warnings.push(m) },
    Event,
    CustomEvent,
    TextEncoder,
  }) as unknown as EventTarget & Record<string, unknown>;
  win["window"] = win;
  const context = createContext(win);
  runInContext(script, context);
  return { win, prompts, warnings };
}

function provider() {
  const signed: Uint8Array[] = [];
  return {
    signed,
    async signMessage(message: Uint8Array) {
      signed.push(message);
      return { signature: new Uint8Array(64) };
    },
  };
}

describe("built extension script", () => {
  it("refuses a derivation request when the user cancels", async () => {
    const { win, prompts, warnings } = page(false);
    const p = provider();
    win["solana"] = p;
    await expect(p.signMessage(DERIVE)).rejects.toMatchObject({ code: 4001, name: "DerivationRequestRefused" });
    await p.signMessage(HELLO);
    expect(p.signed.map((m) => Array.from(m))).toEqual([Array.from(HELLO)]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("https://dapp.example is asking your wallet to sign the Helius Privacy key-derivation message.");
    expect(warnings[0]).toContain("Refused a key-derivation signing request from https://dapp.example (bare)");
  });

  it("signs when the user confirms, naming the Wallet Standard wallet", async () => {
    const { win, prompts } = page(true);
    const signed: Uint8Array[] = [];
    const wallet = {
      name: "Example Wallet",
      features: {
        "solana:signMessage": {
          version: "1.1.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) =>
            inputs.map(({ message }) => (signed.push(message), { signedMessage: message, signature: new Uint8Array(64) })),
        },
      },
    };
    let registered: typeof wallet | undefined;
    win.addEventListener("wallet-standard:register-wallet", (e) =>
      (e as CustomEvent).detail({ register: (w: typeof wallet) => ((registered = w), () => {}) }),
    );
    win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: ({ register }: { register: (w: unknown) => void }) => register(wallet) }));
    expect(registered).toBeDefined();
    expect(registered).not.toBe(wallet);
    await registered!.features["solana:signMessage"].signMessage({ message: DERIVE });
    expect(signed).toHaveLength(1);
    expect(prompts[0]).toContain("through Example Wallet");
  });
});
