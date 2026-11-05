# @ringstack/ringd-client

Types and webhook verification for [ringd](../../apps/ringd).

```ts
import { verifyWebhook, type RingdEvent } from "@ringstack/ringd-client";

const { id, event } = verifyWebhook({
  body: rawBody,                 // string or bytes, exactly as received
  headers: req.headers,          // Node IncomingHttpHeaders, a Fetch Headers, or a plain object
  secret: process.env.RINGD_WEBHOOK_SECRET!, // or [newSecret, oldSecret] while rotating
  toleranceSecs: 300,            // default
});
```

`verifyWebhook` checks the HMAC-SHA256 signature in constant time, rejects timestamps more than `toleranceSecs` away from now, and checks that `ringd-id` matches the event. It throws `WebhookVerificationError` on any failure. Dedupe on `id`: deliveries are at least once.

Wire format: [ringd README](../../apps/ringd/README.md#webhooks). `signPayload` and `webhookHeaders` are what ringd itself uses to sign.
