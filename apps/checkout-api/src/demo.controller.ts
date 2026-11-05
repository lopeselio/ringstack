import { ConflictException, Controller, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";

import type { ApiConfig } from "./config.ts";
import { OrdersService } from "./orders.service.ts";
import { API_CONFIG, DEMO_PAY } from "./tokens.ts";

/** Pays a ringpay: request URI from the demo customer wallet. */
export type DemoPay = (uri: string) => Promise<{ receiptLink: string; signature: string }>;

/** Localnet only: pay an order as the demo customer. 404 when no demo wallet is configured. */
@Controller("demo")
export class DemoController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEMO_PAY) private readonly demoPay: DemoPay | null,
  ) {}

  @Post("orders/:id/pay")
  @HttpCode(200)
  async pay(@Param("id") id: string) {
    if (this.demoPay === null) throw new NotFoundException("demo payments are disabled");
    const order = this.orders.get(id);
    if (order === undefined) throw new NotFoundException("no such order");
    if (order.status === "paid") throw new ConflictException("order is already paid");
    const paid = await this.demoPay(order.uri);
    const verifier = new URL(this.config.verifierUrl);
    verifier.searchParams.set("to", this.config.merchant);
    return {
      signature: paid.signature,
      receiptLink: paid.receiptLink,
      verifierUrl: `${verifier.toString()}#${paid.receiptLink}`,
    };
  }
}
