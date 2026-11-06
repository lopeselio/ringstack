// Writes test-vectors/derivation-requests.json: sign requests a wallet sees,
// whether to refuse each, and what the SDK's own isDerivationInput says.
// The canonical message comes from the SDK, so the vectors track upstream.
import { writeFileSync } from "node:fs";
import { ed25519DerivationMessage, isDerivationInput } from "@heliuslabs/zolana/keypair";
import { inspectSignRequest, OFFCHAIN_MESSAGE_MAGIC, TSPP_APPLICATION_DOMAIN } from "../src/detect.ts";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const u16 = (n: number) => [n & 0xff, n >> 8];

// Any 32 bytes do: the envelope does not check that the signer is a curve point.
type Bytes32 = Parameters<typeof ed25519DerivationMessage>[0];
const SIGNER = Uint8Array.from({ length: 32 }, (_, i) => i + 1) as Bytes32;
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const ZERO_DOMAIN = new Uint8Array(32);

/** Off-chain message v0: magic, version, domain, format, signers, length, payload. */
function offchainV0(payload: Uint8Array, opts: { domain?: Uint8Array; format?: number; signers?: Uint8Array[]; length?: number } = {}) {
  const signers = opts.signers ?? [SIGNER];
  return cat(
    OFFCHAIN_MESSAGE_MAGIC,
    [0],
    opts.domain ?? ZERO_DOMAIN,
    [opts.format ?? 0],
    [signers.length],
    ...signers,
    u16(opts.length ?? payload.length),
    payload,
  );
}

const derive = enc.encode("TSPP/derive/v1");
const canonical = ed25519DerivationMessage(SIGNER);

const cases: { name: string; note: string; bytes: Uint8Array }[] = [
  {
    name: "canonical",
    note: "ed25519DerivationMessage(signer): the exact bytes whose signature is the derivation seed",
    bytes: canonical,
  },
  { name: "bare-v1", note: "The payload alone", bytes: derive },
  { name: "bare-future-version", note: "A later derivation version", bytes: enc.encode("TSPP/derive/v2") },
  {
    name: "offchain-other-domain",
    note: "Derivation payload under an all-zero application domain",
    bytes: offchainV0(derive),
  },
  {
    name: "offchain-utf8-format",
    note: "Derivation payload with format 1 (UTF-8)",
    bytes: offchainV0(derive, { domain: TSPP_APPLICATION_DOMAIN, format: 1 }),
  },
  {
    name: "offchain-two-signers",
    note: "Derivation payload with a second signer",
    bytes: offchainV0(derive, { domain: TSPP_APPLICATION_DOMAIN, signers: [SIGNER, OTHER] }),
  },
  {
    name: "offchain-wrong-length",
    note: "Canonical message with a trailing byte, so the declared length is wrong",
    bytes: cat(canonical, [0x20]),
  },
  {
    name: "offchain-tspp-domain-other-payload",
    note: "TSPP application domain with an unrelated payload",
    bytes: offchainV0(enc.encode("hello"), { domain: TSPP_APPLICATION_DOMAIN }),
  },
  {
    name: "offchain-unknown-version",
    note: "An envelope with version 1 and no application domain",
    bytes: cat(OFFCHAIN_MESSAGE_MAGIC, [1], [1], SIGNER, derive),
  },
  { name: "plain-text", note: "An ordinary sign-in message", bytes: enc.encode("Sign in to example.com\nNonce: 8f2c") },
  {
    name: "siws-mentioning-tspp",
    note: "A Sign-In With Solana message whose statement mentions the payload; its signature is no seed",
    bytes: enc.encode("example.com wants you to sign in with your Solana account:\nTSPP/derive/v1"),
  },
  { name: "lowercase", note: "Case differs, so no SDK derives from it", bytes: enc.encode("tspp/derive/v1") },
  { name: "leading-space", note: "Does not start with the prefix", bytes: enc.encode(" TSPP/derive/v1") },
  { name: "no-version-slash", note: "Shorter than the prefix", bytes: enc.encode("TSPP/derive") },
  { name: "empty", note: "Empty message", bytes: new Uint8Array() },
  {
    name: "offchain-unrelated",
    note: "An off-chain message with another domain and payload",
    bytes: offchainV0(enc.encode("Approve order 1042")),
  },
];

// Written by hand, not read back from the detector: these are the expectations.
const ALLOWED = new Set(["plain-text", "siws-mentioning-tspp", "lowercase", "leading-space", "no-version-slash", "empty", "offchain-unrelated"]);

const vectors = cases.map(({ name, note, bytes }) => {
  const form = inspectSignRequest(bytes);
  if ((form === undefined) !== ALLOWED.has(name)) throw new Error(`detector disagrees on ${name}: ${form ?? "allowed"}`);
  return { name, note, hex: hex(bytes), refuse: form !== undefined, form: form ?? null, sdkRefuses: isDerivationInput(bytes) };
});

const out = new URL("../test-vectors/derivation-requests.json", import.meta.url);
writeFileSync(
  out,
  JSON.stringify(
    {
      description:
        "Sign requests for the Helius Privacy key-derivation message. `refuse` is what a wallet should do for a third-party request; `sdkRefuses` is @heliuslabs/zolana isDerivationInput.",
      sdk: "@heliuslabs/zolana@0.8.0-alpha",
      signer: hex(SIGNER),
      vectors,
    },
    null,
    2,
  ) + "\n",
);
for (const v of vectors) console.log(`${v.refuse ? "refuse" : "allow "} ${v.sdkRefuses ? "sdk:refuse" : "sdk:allow "} ${v.name}`);
