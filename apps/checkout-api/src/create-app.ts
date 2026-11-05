/**
 * Checkout API: NestJS on the Fastify adapter.
 *
 *   GET  /menu                    the items for sale
 *   POST /orders {item}           create an order and its ringpay: request
 *   GET  /orders/:id              order status and matched payments
 *   POST /webhooks/ringd          ringd deliveries (HMAC-verified against the raw body)
 *   POST /demo/orders/:id/pay     localnet only: pay as the demo customer
 */
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule, type AppOptions } from "./app.module.ts";

export async function createApp(
  options: AppOptions & Readonly<{ logger?: boolean }>,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(options), new FastifyAdapter(), {
    rawBody: true,
    logger: options.logger === false ? false : ["log", "warn", "error"],
  });
  app.enableShutdownHooks();
  return app;
}
