/**
 * Funding test wallets with SOL. Localnet uses airdrops. On devnet the faucet
 * is rate-limited, so set ZOLANA_FUNDER_KEYPAIR to a funded Solana keypair
 * file and every `fund` becomes a transfer from it.
 */
import { isAbsolute, resolve } from "node:path";

import { getTransferSolInstruction } from "@solana-program/system";
import { lamports, type Address, type TransactionSigner } from "@solana/kit";

import { loadShieldedKeypair } from "./keys.ts";
import { sendAndConfirmFactory, type SprClient } from "./send.ts";

let funder: Promise<TransactionSigner | undefined> | undefined;

/**
 * A relative ZOLANA_FUNDER_KEYPAIR is relative to where the command was typed.
 * `pnpm --filter <pkg> <script>` runs the script inside the package, so resolve
 * against INIT_CWD, which pnpm sets to the invoking directory.
 */
export function funderPath(env: NodeJS.ProcessEnv): string | undefined {
  const path = env["ZOLANA_FUNDER_KEYPAIR"]?.trim();
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(env["INIT_CWD"] ?? process.cwd(), path);
}

function funderFromEnv(env: NodeJS.ProcessEnv): Promise<TransactionSigner | undefined> {
  const path = funderPath(env);
  funder ??= path ? loadShieldedKeypair(path).then((k) => k.toSolanaSigner()) : Promise.resolve(undefined);
  return funder;
}

/** Send `amount` lamports to `to`: from ZOLANA_FUNDER_KEYPAIR when set, else by airdrop. */
export async function fund(
  client: SprClient,
  to: Address,
  amount: bigint,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const source = await funderFromEnv(env);
  if (source === undefined) {
    await client.confirmTransaction(await client.solanaRpc.requestAirdrop(to, lamports(amount)).send());
    return;
  }
  await sendAndConfirmFactory(client, source, { computeUnitLimit: 10_000 })([
    getTransferSolInstruction({ source, destination: to, amount }),
  ]);
}
