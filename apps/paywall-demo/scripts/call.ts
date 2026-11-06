/**
 * Call a RingPay-paywalled URL from an agent wallet, paying privately if asked.
 *
 *   AGENT_KEYPAIR=.devnet/agent.json ZOLANA_NETWORK=devnet \
 *     pnpm --filter @ringstack/paywall-demo call "https://…/v1/forecast?city=Lisbon"
 *
 * The wallet needs a private SOL balance. Limits: 0.001 SOL per call, 0.01 SOL
 * per day, and only the URL's own host (override with AGENT_MAX_PER_CALL,
 * AGENT_DAILY_BUDGET). Spending is recorded in <keypair>.ledger.json.
 */
import { createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { RingSession, clientConfigFromEnv, loadShieldedKeypair, networkFromEnv, toBaseUnits } from "@ringstack/core";
import { SpendLedger, SpendRefused, paidFetch } from "@ringstack/paywall";

const url = process.argv[2];
const keypair = process.env["AGENT_KEYPAIR"];
if (!url || !keypair) {
  console.error('usage: AGENT_KEYPAIR=<keypair.json> pnpm --filter @ringstack/paywall-demo call "<url>"');
  process.exit(2);
}

await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());
const session = await RingSession.open(client, await loadShieldedKeypair(keypair));

try {
  const { response, payment } = await paidFetch(
    url,
    {},
    {
      session,
      cluster: networkFromEnv(),
      policy: {
        maxPerCall: toBaseUnits(process.env["AGENT_MAX_PER_CALL"] ?? "0.001", 9),
        dailyBudget: toBaseUnits(process.env["AGENT_DAILY_BUDGET"] ?? "0.01", 9),
        allowHosts: [new URL(url).host],
      },
      ledger: new SpendLedger(keypair.replace(/\.json$/, ".ledger.json")),
    },
  );
  console.error(
    payment === undefined
      ? `HTTP ${response.status} (no payment needed)`
      : `HTTP ${response.status}, paid ${payment.amount} lamports privately in ${payment.signature}`,
  );
  console.log(await response.text());
  process.exitCode = response.ok ? 0 : 1;
} catch (e) {
  if (e instanceof SpendRefused) {
    console.error(`refused (${e.code}): ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
