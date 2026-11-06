/**
 * The program's circuits compiled to wasm by `zolana build-zk-program
 * --single-threaded --wasm-target nodejs`, into zk/target/zk/zk-template/wasm.
 * The build output is not committed, so the shapes used here are declared by
 * hand to match the generated `zk_template.d.ts`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProgramWalletUtxo } from "@heliuslabs/spr/program";

export interface TxContext {
  blindingSeed: Uint8Array;
  outputTreeId?: number;
}

export interface UtxoOwner {
  tag: number;
  key: Uint8Array;
  nullifierPk: Uint8Array;
}

export interface VaultTerms {
  creator: UtxoOwner;
  unlock: bigint;
}

/** A decrypted UTXO in the shape the wasm module takes and returns. */
export type WasmWalletUtxo = Record<string, unknown> & { utxoHash: Uint8Array; nullifier: Uint8Array };

export interface DataUtxo<T> {
  utxo: WasmWalletUtxo;
  data: T;
}

export interface LockInputs {
  private: {
    txContext: TxContext;
    tokenUtxosAssetA: ProgramWalletUtxo[];
    unlock: bigint;
    amount: bigint;
  };
  public: { vaultOwner: Uint8Array; creatorIdentity: Uint8Array };
}

export interface ReleaseInputs {
  private: { txContext: TxContext; vault: WasmWalletUtxo; terms: VaultTerms };
  public: { unlock: bigint; creatorIdentity: Uint8Array };
}

export interface CompressedGroth16Proof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

export interface Proof {
  compressedProof: CompressedGroth16Proof;
  publicInputs: Uint8Array[];
}

interface WasmProver {
  prove(proofInputs: Uint8Array): Proof;
  free(): void;
}

export interface TemplateWasm {
  lockTransaction(inputs: LockInputs, sender: Uint8Array, payer: string): unknown;
  releaseTransaction(inputs: ReleaseInputs, sender: Uint8Array, payer: string): unknown;
  vaultTermsDataUtxo(utxo: Record<string, unknown>): DataUtxo<VaultTerms>;
  LockProver: { fromKey(key: Uint8Array, sha256: Uint8Array): WasmProver };
  ReleaseProver: { fromKey(key: Uint8Array, sha256: Uint8Array): WasmProver };
}

const ENTRY = new URL("../../../target/zk/zk-template/wasm/node.mjs", import.meta.url);

export async function loadWasm(): Promise<TemplateWasm> {
  if (!existsSync(fileURLToPath(ENTRY))) {
    throw new Error(
      `${fileURLToPath(ENTRY)} is missing: build it with ` +
        "`cd zk && zolana build-zk-program -p zk-template --single-threaded --wasm-target nodejs`",
    );
  }
  const runtime = (await import(ENTRY.href)) as { default: () => Promise<TemplateWasm> };
  return runtime.default();
}
