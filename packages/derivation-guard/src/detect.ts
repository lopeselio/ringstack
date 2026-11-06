/**
 * Recognises a request to sign the Helius Privacy (TSPP) key-derivation message.
 *
 * The SDK derives a user's viewing and nullifier keys from their wallet's
 * signature over `ed25519DerivationMessage(publicKey)`: a Solana off-chain
 * message v0 whose payload is `"TSPP/derive/v1"`. Whoever holds that signature
 * can read every private payment the user has made or received. This file has
 * no dependencies so a wallet can copy it into its signing path as is.
 *
 * It refuses everything `isDerivationInput` from `@heliuslabs/spr/keypair`
 * refuses (a property test checks this), plus envelopes upstream lets through
 * because they could not produce a seed today but have no honest use either:
 * an off-chain message carrying the TSPP application domain, a payload whose
 * declared length is wrong, and off-chain versions other than 0.
 */

const enc = new TextEncoder();

/** Every derivation payload, current or future, starts with this. */
export const DERIVATION_PAYLOAD_PREFIX = enc.encode("TSPP/derive/");

/** `"\xffsolana offchain"`, the start of every Solana off-chain message. */
export const OFFCHAIN_MESSAGE_MAGIC = Uint8Array.from([
  0xff, 0x73, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x20, 0x6f, 0x66, 0x66, 0x63, 0x68, 0x61, 0x69, 0x6e,
]);

/** `sha256("TSPP/derive/v1")`: the application domain of the derivation message. */
export const TSPP_APPLICATION_DOMAIN = Uint8Array.from([
  0x1d, 0x32, 0xa8, 0x85, 0x33, 0xaf, 0x12, 0xd3, 0x5e, 0x5a, 0xc6, 0xfc, 0xe8, 0x17, 0xa4, 0xcb,
  0x81, 0x0b, 0xcc, 0x41, 0x15, 0x38, 0x6b, 0x14, 0xa7, 0x8e, 0x8b, 0x2e, 0xf0, 0x9d, 0x86, 0x4c,
]);

/**
 * How the request carries the derivation message:
 * - `bare`: the payload itself, `TSPP/derive/...`.
 * - `offchain`: inside a Solana off-chain message envelope.
 * - `tspp-domain`: an off-chain message under the TSPP application domain,
 *   whatever its payload says.
 */
export type DerivationForm = "bare" | "offchain" | "tspp-domain";

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const startsWith = (message: Uint8Array, prefix: Uint8Array) => indexOf(message.subarray(0, prefix.length), prefix) === 0;

/** Accepts the shapes wallets receive message bytes in. */
export function toBytes(message: Uint8Array | ArrayBuffer | ArrayBufferView | readonly number[]): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return Uint8Array.from(message);
}

/** The derivation form of a sign request, or `undefined` when it is safe to sign. */
export function inspectSignRequest(message: Uint8Array): DerivationForm | undefined {
  if (startsWith(message, DERIVATION_PAYLOAD_PREFIX)) return "bare";
  if (!startsWith(message, OFFCHAIN_MESSAGE_MAGIC)) return undefined;
  // Any envelope version, any signer count, any declared length: the payload
  // follows the header, so look for the prefix anywhere after the magic.
  if (indexOf(message, DERIVATION_PAYLOAD_PREFIX, OFFCHAIN_MESSAGE_MAGIC.length) !== -1) return "offchain";
  if (indexOf(message, TSPP_APPLICATION_DOMAIN, OFFCHAIN_MESSAGE_MAGIC.length) !== -1) return "tspp-domain";
  return undefined;
}

/** True when a wallet must not sign `message` for a third party. */
export function isTsppDerivationRequest(message: Uint8Array | ArrayBuffer | ArrayBufferView | readonly number[]): boolean {
  return inspectSignRequest(toBytes(message)) !== undefined;
}
