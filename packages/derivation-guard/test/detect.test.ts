import { readFileSync } from "node:fs";
import {
  DERIVATION_PAYLOAD_PREFIX as SDK_PREFIX,
  OFFCHAIN_MESSAGE_MAGIC as SDK_MAGIC,
  TSPP_APPLICATION_DOMAIN as SDK_DOMAIN,
  ed25519DerivationMessage,
  isDerivationInput,
} from "@heliuslabs/spr/keypair";
import { describe, expect, it } from "vitest";
import {
  DERIVATION_PAYLOAD_PREFIX,
  OFFCHAIN_MESSAGE_MAGIC,
  TSPP_APPLICATION_DOMAIN,
  inspectSignRequest,
  isTsppDerivationRequest,
} from "../src/detect.ts";

interface Vector {
  name: string;
  hex: string;
  refuse: boolean;
  form: string | null;
  sdkRefuses: boolean;
}
const file = JSON.parse(readFileSync(new URL("../test-vectors/derivation-requests.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};
type Bytes32 = Parameters<typeof ed25519DerivationMessage>[0];
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("detector", () => {
  it("uses the SDK's constants", () => {
    expect(new TextDecoder().decode(DERIVATION_PAYLOAD_PREFIX)).toBe(SDK_PREFIX);
    expect(OFFCHAIN_MESSAGE_MAGIC).toEqual(SDK_MAGIC);
    expect(TSPP_APPLICATION_DOMAIN).toEqual(SDK_DOMAIN);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))("vector %s", (_, v) => {
    const message = bytes(v.hex);
    expect(inspectSignRequest(message) ?? null).toBe(v.form);
    expect(isTsppDerivationRequest(message)).toBe(v.refuse);
    expect(isDerivationInput(message)).toBe(v.sdkRefuses);
  });

  it("refuses the canonical message for any signer, in every byte shape", () => {
    for (let i = 0; i < 64; i++) {
      const signer = crypto.getRandomValues(new Uint8Array(32));
      const message = ed25519DerivationMessage(signer as Bytes32);
      expect(isTsppDerivationRequest(message)).toBe(true);
      expect(isTsppDerivationRequest(message.buffer as ArrayBuffer)).toBe(true);
      expect(isTsppDerivationRequest(Array.from(message))).toBe(true);
      const padded = new Uint8Array(message.length + 8);
      padded.set(message, 4);
      expect(isTsppDerivationRequest(padded.subarray(4, 4 + message.length))).toBe(true);
      expect(isTsppDerivationRequest(new DataView(padded.buffer, 4, message.length))).toBe(true);
    }
  });

  it("refuses everything the SDK refuses", () => {
    // Mutate the canonical and bare messages byte by byte, truncate and extend
    // them, and check the detector is never weaker than isDerivationInput.
    const seeds = [ed25519DerivationMessage(new Uint8Array(32).fill(7) as Bytes32), new TextEncoder().encode("TSPP/derive/v1")];
    let sdkRefused = 0;
    for (const seed of seeds) {
      for (let trial = 0; trial < 4000; trial++) {
        const m = Uint8Array.from(seed);
        const at = trial % m.length;
        const kind = trial % 4;
        let message: Uint8Array;
        if (kind === 0) {
          m[at] = crypto.getRandomValues(new Uint8Array(1))[0]!;
          message = m;
        } else if (kind === 1) message = m.subarray(0, at);
        else if (kind === 2) message = Uint8Array.from([...m, ...crypto.getRandomValues(new Uint8Array(at % 9))]);
        else message = Uint8Array.from([...m.subarray(0, at), ...m.subarray(at + 1)]);
        if (isDerivationInput(message)) {
          sdkRefused++;
          expect(isTsppDerivationRequest(message), Buffer.from(message).toString("hex")).toBe(true);
        }
      }
    }
    expect(sdkRefused).toBeGreaterThan(1000);
  });
});
