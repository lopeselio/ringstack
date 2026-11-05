import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { WebhookVerificationError, verifyWebhook } from "@ringstack/ringd-client";
import type { FastifyRequest } from "fastify";

import type { ApiConfig } from "./config.ts";
import { OrdersService } from "./orders.service.ts";
import { API_CONFIG } from "./tokens.ts";

/** ringd deliveries. Verified against the raw body (the app is created with `rawBody: true`). */
@Controller("webhooks")
export class WebhooksController {
  private readonly log = new Logger("ringd");

  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post("ringd")
  @HttpCode(204)
  ringd(@Req() req: RawBodyRequest<FastifyRequest>): void {
    if (req.rawBody === undefined) throw new BadRequestException("missing body");
    let verified;
    try {
      verified = verifyWebhook({ body: req.rawBody, headers: req.headers, secret: this.config.webhookSecret });
    } catch (err) {
      if (err instanceof WebhookVerificationError) throw new BadRequestException(err.message);
      throw err;
    }
    const { id, event } = verified;
    if (event.type !== "payment.received") return;
    const outcome = this.orders.recordPayment(id, event);
    this.log.log(`${id} ${outcome}${event.memo ? ` memo=${event.memo}` : ""}`);
  }
}
