import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { ShieldedKeypair, SigningKey, type Bytes32 } from "@heliuslabs/zolana";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

/** Parse a Solana CLI keypair file body (JSON array of 64 bytes: seed || pubkey). */
export function parseSolanaKeypairJson(body: string): Bytes32 {
  const secret: unknown = JSON.parse(body);
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    secret.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
  ) {
    throw new Error("expected a Solana CLI keypair: JSON array of 64 bytes");
  }
  return Uint8Array.from(secret.slice(0, 32)) as Bytes32;
}

/** Load the Ed25519 signing key from a Solana CLI keypair file. */
export async function loadSigningKey(path: string): Promise<SigningKey> {
  const seed = parseSolanaKeypairJson(await readFile(expandHome(path), "utf8"));
  try {
    return SigningKey.fromEd25519Bytes(seed);
  } finally {
    seed.fill(0);
  }
}

/**
 * Load a shielded keypair whose signing key is the given Solana keypair file.
 * The nullifier and viewing keys are derived from the same seed by the SDK.
 */
export async function loadShieldedKeypair(path: string): Promise<ShieldedKeypair> {
  return ShieldedKeypair.fromKeypair(await loadSigningKey(path));
}
