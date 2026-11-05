/**
 * Run the paid demo API.
 *
 *   VENDOR_KEY_FILE   read-only key file of the vendor (`ringd keys export`)
 *   VENDOR_ADDRESS    the vendor's registered Solana address
 *   ZOLANA_NETWORK    devnet (API_KEY from the root .env) or localnet
 *   PRICE             SOL per call (default 0.0005)
 *   PORT, HOST        default 8080, 0.0.0.0
 *
 * The server holds only the vendor's viewing and nullifier keys: it can see
 * payments to the vendor but cannot move the vendor's funds.
 */
import { createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { clientConfigFromEnv, networkFromEnv, readKeyFile } from "@ringstack/core";
import { address } from "@solana/kit";

import { createDemoApp } from "./app.ts";

const keyFile = process.env["VENDOR_KEY_FILE"];
const recipient = process.env["VENDOR_ADDRESS"];
if (!keyFile || !recipient) throw new Error("set VENDOR_KEY_FILE and VENDOR_ADDRESS");

await initializePoseidon();
const keys = await readKeyFile(keyFile);
const client = await createZolanaClient(clientConfigFromEnv());
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
