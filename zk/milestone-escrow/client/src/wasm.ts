/**
 * The escrow's circuits compiled to wasm by `zolana build-zk-program -p
 * milestone-escrow --single-threaded --wasm-target nodejs`, into
 * zk/target/zk/milestone-escrow/wasm. The build output is not committed, so
 * the shapes used here are declared by hand to match `milestone_escrow.d.ts`.
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

export interface EscrowTerms {
  funder: UtxoOwner;
  escrowAddress: Uint8Array;
  payee: Uint8Array;
  approvers: number[][];
  threshold: number;
  tranche: bigint;
  deadline: bigint;
}

/** A decrypted UTXO in the shape the wasm module takes and returns. */
export type WasmWalletUtxo = Record<string, unknown> & {
  utxoHash: Uint8Array;
  nullifier: Uint8Array;
  utxo: { amount: bigint };
};

export interface DataUtxo<T> {
  utxo: WasmWalletUtxo;
  data: T;
}

export interface CreateInputs {
  private: {
    txContext: TxContext;
    tokenUtxosAssetA: ProgramWalletUtxo[];
    amount: bigint;
    payee: Uint8Array;
    approvers: number[][];
    threshold: number;
    tranche: bigint;
  };
  public: { escrowOwner: Uint8Array; funderIdentity: Uint8Array; deadline: bigint };
}

export interface ReleaseInputs {
  private: {
    txContext: TxContext;
    escrow: WasmWalletUtxo;
    terms: EscrowTerms;
    payee: Uint8Array;
    escrowOwner: Uint8Array;
  };
  public: { deadline: bigint; funderIdentity: Uint8Array; signers: number[][] };
}

export interface RefundInputs {
  private: { txContext: TxContext; escrow: WasmWalletUtxo; terms: EscrowTerms };
  public: { deadline: bigint; funderIdentity: Uint8Array };
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

type ProverClass = { fromKey(key: Uint8Array, sha256: Uint8Array): WasmProver };

export interface EscrowWasm {
  createTransaction(inputs: CreateInputs, sender: Uint8Array, payer: string): unknown;
  releaseTransaction(inputs: ReleaseInputs, sender: Uint8Array, payer: string): unknown;
  refundTransaction(inputs: RefundInputs, sender: Uint8Array, payer: string): unknown;
  escrowTermsDataUtxo(utxo: Record<string, unknown>): DataUtxo<EscrowTerms>;
  CreateProver: ProverClass;
  ReleaseProver: ProverClass;
  RefundProver: ProverClass;
}

const ENTRY = new URL("../../../target/zk/milestone-escrow/wasm/node.mjs", import.meta.url);

export async function loadWasm(): Promise<EscrowWasm> {
  if (!existsSync(fileURLToPath(ENTRY))) {
    throw new Error(
      `${fileURLToPath(ENTRY)} is missing: build it with ` +
        "`cd zk && zolana build-zk-program -p milestone-escrow --single-threaded --wasm-target nodejs`",
    );
  }
  const runtime = (await import(ENTRY.href)) as { default: () => Promise<EscrowWasm> };
  return runtime.default();
}
