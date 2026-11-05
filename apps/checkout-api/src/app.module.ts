import { Module, type DynamicModule } from "@nestjs/common";

import type { ApiConfig } from "./config.ts";
import type { CheckoutDb } from "./db.ts";
import { DemoController, type DemoPay } from "./demo.controller.ts";
import { OrdersController } from "./orders.controller.ts";
import { OrdersService } from "./orders.service.ts";
import { API_CONFIG, CHECKOUT_DB, DEMO_PAY } from "./tokens.ts";
import { WebhooksController } from "./webhooks.controller.ts";

export interface AppOptions {
  readonly config: ApiConfig;
  readonly db: CheckoutDb;
  /** Present only when demo payments are enabled (localnet). */
  readonly demoPay?: DemoPay;
}

@Module({})
export class AppModule {
  static forRoot({ config, db, demoPay }: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [OrdersController, WebhooksController, DemoController],
      providers: [
        OrdersService,
        { provide: API_CONFIG, useValue: config },
        { provide: CHECKOUT_DB, useValue: db },
        { provide: DEMO_PAY, useValue: demoPay ?? null },
      ],
    };
  }
}
