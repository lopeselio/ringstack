/**
 * A pay-per-call API behind a RingPay paywall (x402-style).
 *
 *   GET /                       free: what this API sells and how to pay
 *   GET /health                 free
 *   GET /v1/forecast?city=…     paid: a (made-up) weather forecast
 *   GET /v1/alerts?city=…       paid: (made-up) weather alerts
 *
 * Unpaid calls get 402 with a `ringpay:` request; calls that carry a valid
 * RingPay-Payment signature are served.
 */
import { Paywall, resourceOf, type PaywallConfig } from "@ringstack/paywall";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export interface DemoConfig {
  readonly paywall: PaywallConfig;
  /** UI units of SOL per call. */
  readonly price: string;
  readonly logger?: boolean;
}

const CONDITIONS = ["clear", "light rain", "overcast", "windy", "fog in the morning", "thunderstorms late"];

function seeded(city: string, salt: number): number {
  let h = salt;
  for (const c of city.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function forecast(city: string) {
  const day = new Date().toISOString().slice(0, 10);
  return {
    city,
    date: day,
    days: [0, 1, 2].map((i) => {
      const h = seeded(city, i + Number(day.replaceAll("-", "")));
      return { day: i, high: 12 + (h % 18), low: 4 + (h % 9), conditions: CONDITIONS[h % CONDITIONS.length] };
    }),
    note: "Demo data. Paid privately: the amount and this order's id travelled encrypted.",
  };
}

function alerts(city: string) {
  const h = seeded(city, 7);
  return { city, alerts: h % 3 === 0 ? [{ level: "yellow", text: "Strong wind gusts this afternoon" }] : [] };
}

export function createDemoApp({ paywall: config, price, logger = false }: DemoConfig): FastifyInstance {
  const paywall = new Paywall(config);
  const app = Fastify({ logger });

  app.get("/", async () => ({
    name: "ringstack paid forecast API (demo)",
    cluster: config.cluster,
    price: `${price} SOL per call`,
    paid: ["/v1/forecast?city=…", "/v1/alerts?city=…"],
    howToPay:
      "Call a paid route; you get HTTP 402 with a ringpay: request. Pay it privately (the order id goes in the encrypted memo), then retry with the header RingPay-Payment: <transaction signature>.",
    client: "@ringstack/paywall paidFetch, or the ringstack MCP server",
  }));

  app.get("/health", async () => ({ ok: true }));

  const charge =
    <T>(serve: (city: string) => T) =>
    async (req: FastifyRequest<{ Querystring: { city?: string } }>, reply: FastifyReply) => {
      const header = req.headers["ringpay-payment"];
      const decision = await paywall.decide(
        Array.isArray(header) ? header[0] : header,
        resourceOf(req.method, req.url),
        price,
      );
      reply.headers(decision.headers);
      if (!decision.paid) return reply.code(402).send(decision.body);
      return serve((req.query.city ?? "Lisbon").slice(0, 64));
    };

  app.get("/v1/forecast", charge(forecast));
  app.get("/v1/alerts", charge(alerts));
  return app;
}
