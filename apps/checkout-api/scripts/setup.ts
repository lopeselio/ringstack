/**
 * Setup for the checkout demo on ZOLANA_NETWORK (devnet: API_KEY in the root
 * .env and ZOLANA_FUNDER_KEYPAIR set, since the devnet faucet is closed):
 *   - merchant: new keypair, registered; ringd gets its read-only key file
 *   - customer: new keypair, registered, funded, 0.05 SOL deposited privately
 *   - writes .env (API) and .demo/ringd.toml (ringd → API webhook)
 *
 *   pnpm --filter @ringstack/checkout-api demo:setup [--force]
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { RingSession, clientConfigFromEnv, fund, loadShieldedKeypair, networkFromEnv } from "@ringstack/core";

const root = resolve(import.meta.dirname, "..");
const demo = join(root, ".demo");
const force = process.argv.includes("--force");

if (existsSync(demo) && !force) {
  console.error(".demo/ already exists; rerun with --force to start over (wipes demo keys and databases)");
  process.exit(1);
}
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { mode: 0o700 });

function writeSolanaKeypair(path: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  writeFileSync(path, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
}

await initializePoseidon();
const network = networkFromEnv();
const client = await createZolanaClient(clientConfigFromEnv());

const merchantKeyPath = join(demo, "merchant.json");
const customerKeyPath = join(demo, "customer.json");
writeSolanaKeypair(merchantKeyPath);
writeSolanaKeypair(customerKeyPath);

const merchant = await RingSession.open(client, await loadShieldedKeypair(merchantKeyPath));
const customer = await RingSession.open(client, await loadShieldedKeypair(customerKeyPath));
for (const s of [merchant, customer]) {
  await fund(client, s.owner, s === customer ? 80_000_000n : 20_000_000n);
}
await merchant.register();
// Registered so receipts can match the customer's change output to the chain too.
await customer.register();
await customer.deposit(50_000_000n);
console.log(`merchant  ${merchant.owner} (registered)`);
console.log(`customer  ${customer.owner} (registered, 0.05 SOL private balance)`);

// ringd holds only the merchant's viewing + nullifier keys.
const { exportKeyFile } = await import("../../ringd/src/keyfile.ts");
writeFileSync(join(demo, "merchant.ringd-key.json"), exportKeyFile(merchant.keypair), { mode: 0o600 });

const secret = randomBytes(32).toString("hex");
writeFileSync(
  join(root, ".env"),
  [
    `# Written by demo:setup (${network} demo). Do not commit.`,
    `MERCHANT_ADDRESS=${merchant.owner}`,
    `RINGD_WEBHOOK_SECRET=${secret}`,
    `CLUSTER=${network}`,
    "DATABASE=.demo/checkout.db",
    "DEMO_CUSTOMER_KEYPAIR=.demo/customer.json",
    "VERIFIER_URL=https://lopeselio.github.io/ringstack/verify/",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
writeFileSync(
  join(demo, "ringd.toml"),
  `network = "${network}"
database = "./ringd.db"
poll_interval_secs = 2

[[wallet]]
name = "shop"
key_file = "./merchant.ringd-key.json"

[[webhook]]
name = "checkout"
url = "http://127.0.0.1:4000/webhooks/ringd"
secret_env = "RINGD_WEBHOOK_SECRET"
events = ["payment.received"]

[delivery]
retry_base_secs = 1
retry_max_secs = 30
`,
);

console.log(`
wrote apps/checkout-api/.env and apps/checkout-api/.demo/ (keys, ringd.toml)

run, each in its own terminal:
  pnpm --filter @ringstack/checkout-api start     # API on :4000
  pnpm --filter @ringstack/checkout-api ringd     # ringd watching the merchant
  pnpm --filter @ringstack/checkout-demo dev      # shop on :3000
  pnpm --filter @ringstack/verifier dev           # receipt verifier on :5173 (optional)`);
