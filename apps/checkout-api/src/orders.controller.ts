import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";

import type { ApiConfig } from "./config.ts";
import type { Order } from "./db.ts";
import { MENU, SHOP_NAME } from "./menu.ts";
import { OrdersService } from "./orders.service.ts";
import { API_CONFIG, DEMO_PAY } from "./tokens.ts";
import type { DemoPay } from "./demo.controller.ts";

@Controller()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEMO_PAY) private readonly demoPay: DemoPay | null,
  ) {}

  @Get("menu")
  menu() {
    return { shop: SHOP_NAME, cluster: this.config.cluster, demo: this.demoPay !== null, items: MENU };
  }

  @Post("orders")
  create(@Body() body: { item?: unknown } | undefined): Order {
    const order = this.orders.create(body?.item);
    if (order === undefined) throw new BadRequestException("unknown item");
    return order;
  }

  @Get("orders/:id")
  get(@Param("id") id: string): Order {
    const order = this.orders.get(id);
    if (order === undefined) throw new NotFoundException("no such order");
    return order;
  }
}
