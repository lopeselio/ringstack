import { ShieldedKeypair, createSprClient } from "@heliuslabs/spr";
import { RingSession, clientConfigFromEnv, loadShieldedKeypair, payRequest } from "@ringstack/core";

import { loadApiConfig } from "./config.ts";
import { CheckoutDb } from "./db.ts";
import { createApp } from "./create-app.ts";
import type { DemoPay } from "./demo.controller.ts";

const config = loadApiConfig();
const db = new CheckoutDb(config.database);

/** Demo customer wallet (test networks only): one session, payments serialized. */
async function demoPayer(path: string): Promise<DemoPay> {
  const client = await createSprClient(clientConfigFromEnv({ ...process.env, ZOLANA_NETWORK: config.cluster }));
  const keypair: ShieldedKeypair = await loadShieldedKeypair(path);
  const session = await RingSession.open(client, keypair);
  let queue: Promise<unknown> = Promise.resolve();
  return (uri) => {
    const run = queue.then(async () => {
      await session.sync();
      const paid = await payRequest(session, uri, { cluster: config.cluster });
      return { receiptLink: paid.receiptLink, signature: paid.payment.signature };
    });
    queue = run.catch(() => {});
    return run;
  };
}

const demoPay = config.demoCustomerKeypair ? await demoPayer(config.demoCustomerKeypair) : undefined;
const app = await createApp({ config, db, ...(demoPay ? { demoPay } : {}) });
// enableShutdownHooks closes the app on SIGINT/SIGTERM; close the database after it.
process.once("exit", () => db.close());

await app.listen(config.port, config.host);
