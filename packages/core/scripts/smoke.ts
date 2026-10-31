/**
 * Localnet smoke test: airdrop → deposit SOL → confidential transfer → decrypt.
 *
 *   scripts/install-zolana.sh && scripts/localnet.sh   # in another terminal
 *   pnpm --filter @ringstack/core smoke
 */
import { depositAndTransfer } from "./flow.ts";

const { change } = await depositAndTransfer();
console.log(`ok: private change ${change} lamports`);
