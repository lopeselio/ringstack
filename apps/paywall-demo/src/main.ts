/**
 * Run the paid demo API.
 *
 *   VENDOR_KEY_FILE   read-only key file of the vendor (`ringd keys export`), or
 *   VENDOR_KEY        the same file's JSON content (for hosts with env-only secrets)
 *   VENDOR_ADDRESS    the vendor's registered Solana address
 *   ZOLANA_NETWORK    devnet (API_KEY from the root .env) or localnet
 *   PRICE             SOL per call (default 0.0005)
 *   PORT, HOST        default 8080, 0.0.0.0
 *
 * The server holds only the vendor's viewing and nullifier keys: it can see
 * payments to the vendor but cannot move the vendor's funds.
 */
import { createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { clientConfigFromEnv, networkFromEnv, parseKeyFile, readKeyFile } from "@ringstack/core";
import { address } from "@solana/kit";

import { createDemoApp } from "./app.ts";

const keyFile = process.env["VENDOR_KEY_FILE"];
const keyJson = process.env["VENDOR_KEY"];
const recipient = process.env["VENDOR_ADDRESS"];
if ((!keyFile && !keyJson) || !recipient) throw new Error("set VENDOR_ADDRESS and VENDOR_KEY_FILE or VENDOR_KEY");

await initializePoseidon();
const keys = keyJson ? parseKeyFile(keyJson) : await readKeyFile(keyFile!);
const client = await createSprClient(clientConfigFromEnv());
const app = createDemoApp({
  paywall: {
    client,
    vendor: { address: keys.address, viewingSecret: keys.viewingSecret },
    recipient: address(recipient),
    cluster: networkFromEnv(),
    label: "Forecast API",
  },
  price: process.env["PRICE"] ?? "0.0005",
  logger: true,
});
await app.listen({ port: Number(process.env["PORT"] ?? 8080), host: process.env["HOST"] ?? "0.0.0.0" });
