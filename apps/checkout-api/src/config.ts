/**
 * Environment for the checkout API. `demo:setup` writes a localnet `.env`.
 *
 *   MERCHANT_ADDRESS        registered Solana address that receives payments
 *   RINGD_WEBHOOK_SECRET    shared with ringd's [[webhook]] secret_env (≥ 16 chars)
 *   CLUSTER                 localnet | devnet            (default localnet)
 *   DATABASE                SQLite path                  (default ./checkout.db)
 *   PORT, HOST              listen address               (default 4000, 127.0.0.1)
 *   VERIFIER_URL            receipt verifier base URL    (default http://localhost:5173/)
 *   DEMO_CUSTOMER_KEYPAIR   localnet only: Solana keypair file the demo "pay" button spends from
 */
import { isAddress, type Address } from "@solana/kit";
import type { Cluster } from "@ringstack/core/receipt";

export interface ApiConfig {
  readonly merchant: Address;
  readonly webhookSecret: string;
  readonly cluster: Cluster;
  readonly database: string;
  readonly port: number;
  readonly host: string;
  readonly verifierUrl: string;
  readonly demoCustomerKeypair?: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const merchant = env["MERCHANT_ADDRESS"]?.trim();
  if (!merchant || !isAddress(merchant)) throw new Error("MERCHANT_ADDRESS must be a Solana address (run demo:setup)");
  const webhookSecret = env["RINGD_WEBHOOK_SECRET"] ?? "";
  if (webhookSecret.length < 16) throw new Error("RINGD_WEBHOOK_SECRET must be at least 16 characters");
  const cluster = (env["CLUSTER"]?.trim() || "localnet") as Cluster;
  if (cluster !== "localnet" && cluster !== "devnet") throw new Error("CLUSTER must be localnet or devnet");
  const demo = env["DEMO_CUSTOMER_KEYPAIR"]?.trim();
  if (demo && cluster !== "localnet") throw new Error("DEMO_CUSTOMER_KEYPAIR is only allowed on localnet");
  return {
    merchant,
    webhookSecret,
    cluster,
    database: env["DATABASE"]?.trim() || "./checkout.db",
    port: Number(env["PORT"] ?? 4000),
    host: env["HOST"]?.trim() || "127.0.0.1",
    verifierUrl: env["VERIFIER_URL"]?.trim() || "http://localhost:5173/",
    ...(demo ? { demoCustomerKeypair: demo } : {}),
  };
}
