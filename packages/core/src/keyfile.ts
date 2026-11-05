/**
 * Read-only key files (used by ringd and the paywall) hold the read-only roles of one shielded identity: the
 * viewing key (decrypts outputs) and the nullifier key (detects spends), plus
 * the public shielded address. Never the Ed25519 spending key, so a stolen key
 * file can read the wallet but not move funds.
 *
 * Format (JSON, written with mode 0600):
 *   { "version": 1, "address": base64, "viewingKey": hex(32), "nullifierKey": hex(31) }
 */
import { chmod, readFile, writeFile } from "node:fs/promises";

import { LocalShieldedKeys, NullifierKey, ShieldedAddress, ViewingKey, type ShieldedKeypair } from "@heliuslabs/zolana";
import { bytes31, bytes32 } from "@heliuslabs/zolana/keypair";

export const KEY_FILE_VERSION = 1;

interface KeyFileJson {
  readonly version: number;
  readonly address: string;
  readonly viewingKey: string;
  readonly nullifierKey: string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function unhex(s: unknown, len: number, field: string): Uint8Array {
  if (typeof s !== "string" || !/^[0-9a-f]*$/i.test(s) || s.length !== len * 2) {
    throw new Error(`key file: ${field} must be ${len} bytes of hex`);
  }
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/** Serialize the read-only roles of `keypair`. */
export function exportKeyFile(keypair: ShieldedKeypair): string {
  const viewing = keypair.viewingKey();
  const nullifier = keypair.nullifierKey();
  try {
    const body: KeyFileJson = {
      version: KEY_FILE_VERSION,
      address: Buffer.from(keypair.shieldedAddress().toBytes()).toString("base64"),
      viewingKey: hex(viewing.secretBytes()),
      nullifierKey: hex(nullifier.secretBytes()),
    };
    return `${JSON.stringify(body, null, 2)}\n`;
  } finally {
    viewing.destroy();
    nullifier.destroy();
  }
}

export interface WatchKeys {
  readonly address: ShieldedAddress;
  readonly keys: LocalShieldedKeys;
  /** Copy of the viewing secret, for deriving the snapshot cipher key. Caller wipes it. */
  readonly viewingSecret: Uint8Array;
  /** Copy of the nullifier secret, for merges (which spend the wallet's UTXOs). */
  readonly nullifierSecret: Uint8Array;
}

/** Parse a key file and check that its secrets match its address. */
export function parseKeyFile(text: string): WatchKeys {
  let json: Partial<KeyFileJson>;
  try {
    json = JSON.parse(text) as Partial<KeyFileJson>;
  } catch {
    throw new Error("key file is not JSON");
  }
  if (json.version !== KEY_FILE_VERSION) throw new Error(`key file: unsupported version ${String(json.version)}`);
  if (typeof json.address !== "string") throw new Error("key file: address missing");

  const address = ShieldedAddress.fromBytes(Uint8Array.from(Buffer.from(json.address, "base64")));
  const viewingSecret = unhex(json.viewingKey, 32, "viewingKey");
  const viewing = ViewingKey.fromBytes(bytes32(viewingSecret.slice()));
  const nullifierSecret = unhex(json.nullifierKey, 31, "nullifierKey");
  const nullifier = NullifierKey.fromSecret(bytes31(nullifierSecret.slice()));
  try {
    const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!eq(viewing.publicKey().toBytes(), address.viewingPublicKey.toBytes())) {
      throw new Error("key file: viewingKey does not match address");
    }
    if (!eq(nullifier.publicKey(), address.nullifierPublicKey)) {
      throw new Error("key file: nullifierKey does not match address");
    }
    const keys = LocalShieldedKeys.fromKeys({ address, viewingKeys: [viewing], nullifierKey: nullifier });
    return { address, keys, viewingSecret, nullifierSecret };
  } finally {
    viewing.destroy();
    nullifier.destroy();
  }
}

export async function writeKeyFile(path: string, keypair: ShieldedKeypair): Promise<void> {
  await writeFile(path, exportKeyFile(keypair), { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

export async function readKeyFile(path: string): Promise<WatchKeys> {
  return parseKeyFile(await readFile(path, "utf8"));
}
