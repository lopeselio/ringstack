/**
 * Webhook delivery: signed POSTs with retry.
 *
 * - Body: the event JSON. Headers: see @ringstack/ringd-client (`ringd-id` is
 *   the idempotency key and is identical on every retry).
 * - 2xx is success. Anything else (status, timeout, network error) is retried
 *   with exponential backoff until `maxAttempts`, then marked failed.
 * - Webhooks are independent. Within one, events go oldest first, and the first
 *   failure ends that webhook's pass so a down endpoint is not hammered.
 * - Redirects are not followed.
 */
import { deliveryId, webhookHeaders, type RingdEvent } from "@ringstack/ringd-client";

import type { DeliveryConfig, WebhookConfig } from "./config.ts";
import type { Logger } from "./daemon.ts";
import type { RingdStore } from "./store.ts";

/** Which webhooks an event goes to. */
export function routeFor(webhooks: readonly WebhookConfig[]): (e: RingdEvent) => string[] {
  return (e) =>
    webhooks
      .filter((w) => (w.wallets === undefined || w.wallets.includes(e.wallet)) && (w.events?.includes(e.type) ?? true))
      .map((w) => w.name);
}

/** Delay before the next attempt, after `attempts` failed ones (≥ 1). */
export function backoffMs(attempts: number, cfg: Pick<DeliveryConfig, "retryBaseMs" | "retryMaxMs">): number {
  return Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** Math.max(0, attempts - 1));
}

export interface DispatchResult {
  delivered: number;
  retrying: number;
  failed: number;
}

type Fetch = typeof fetch;

export class Dispatcher {
  constructor(
    private readonly store: RingdStore,
    private readonly webhooks: readonly WebhookConfig[],
    private readonly delivery: DeliveryConfig,
    private readonly log: Logger,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** One pass over every due delivery. */
  async runOnce(now: number = Date.now()): Promise<DispatchResult> {
    const result: DispatchResult = { delivered: 0, retrying: 0, failed: 0 };
    await Promise.all(this.webhooks.map((w) => this.#runWebhook(w, now, result)));
    return result;
  }

  async #runWebhook(webhook: WebhookConfig, now: number, result: DispatchResult): Promise<void> {
    for (const d of this.store.dueDeliveries([webhook.name], now)) {
      const outcome = await this.#attempt(webhook, d.event);
      const attempts = d.attempts + 1;
      if (outcome.ok) {
        this.store.recordAttempt(webhook.name, d.seq, { ok: true, status: outcome.status! });
        this.log.info("webhook delivered", { webhook: webhook.name, seq: d.seq, id: deliveryId(d.event), attempts });
        result.delivered++;
        continue;
      }
      const giveUp = attempts >= this.delivery.maxAttempts;
      const nextAttemptAt = giveUp ? undefined : Date.now() + backoffMs(attempts, this.delivery);
      this.store.recordAttempt(webhook.name, d.seq, {
        ok: false,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        error: outcome.error,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      });
      (giveUp ? this.log.error : this.log.info)(giveUp ? "webhook failed" : "webhook retry scheduled", {
        webhook: webhook.name,
        seq: d.seq,
        attempts,
        error: outcome.error,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt: new Date(nextAttemptAt).toISOString() }),
      });
      if (giveUp) result.failed++;
      else result.retrying++;
      break; // endpoint is unhealthy; leave the rest for the next pass
    }
  }

  async #attempt(webhook: WebhookConfig, event: RingdEvent): Promise<{ ok: boolean; status?: number; error: string }> {
    const body = JSON.stringify(event);
    try {
      const res = await this.fetchImpl(webhook.url, {
        method: "POST",
        headers: { ...webhookHeaders(webhook.secret, deliveryId(event), body), "user-agent": "ringd" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.delivery.timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, error: ok ? "" : `HTTP ${res.status}` };
    } catch (err) {
      const e = err as Error;
      return { ok: false, error: e.name === "TimeoutError" ? "timeout" : e.message };
    }
  }
}
