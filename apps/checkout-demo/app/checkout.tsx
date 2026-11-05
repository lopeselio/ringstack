"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: string;
}

interface Menu {
  shop: string;
  cluster: string;
  demo: boolean;
  items: MenuItem[];
}

interface Payment {
  deliveryId: string;
  signature: string;
  amount: string;
  receivedAt: string;
}

interface Order {
  id: string;
  item: string;
  price: string;
  priceBase: string;
  uri: string;
  status: "awaiting_payment" | "underpaid" | "paid";
  received: string;
  paidAt?: string;
  payments: Payment[];
}

interface DemoPayment {
  signature: string;
  verifierUrl: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // Only declare JSON when sending a body: Fastify rejects an empty JSON body.
    headers: init?.body === undefined ? init?.headers : { "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  return body;
}

const sol = (base: string) => {
  const s = base.padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "");
};
const short = (s: string, n = 6) => `${s.slice(0, n)}…${s.slice(-n)}`;

export function Checkout() {
  const [menu, setMenu] = useState<Menu>();
  const [order, setOrder] = useState<Order>();
  const [qr, setQr] = useState<string>();
  const [demo, setDemo] = useState<DemoPayment>();
  const [busy, setBusy] = useState<"order" | "pay" | undefined>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<Menu>("/menu")
      .then(setMenu)
      .catch(() => setError("The checkout API isn't reachable. Start it with pnpm --filter @ringstack/checkout-api start."));
  }, []);

  // Poll the order until it is paid; ringd's webhook updates it server-side.
  useEffect(() => {
    if (order === undefined || order.status === "paid") return;
    const t = setInterval(() => {
      api<Order>(`/orders/${order.id}`).then(setOrder).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [order?.id, order?.status]);

  useEffect(() => {
    if (order === undefined) return setQr(undefined);
    QRCode.toString(order.uri, { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then(setQr);
  }, [order?.uri]);

  const place = useCallback(async (item: string) => {
    setBusy("order");
    setError(undefined);
    setDemo(undefined);
    setCopied(false);
    try {
      setOrder(await api<Order>("/orders", { method: "POST", body: JSON.stringify({ item }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }, []);

  const payAsDemo = useCallback(async () => {
    if (order === undefined) return;
    setBusy("pay");
    setError(undefined);
    try {
      setDemo(await api<DemoPayment>(`/demo/orders/${order.id}/pay`, { method: "POST" }));
    } catch (e) {
      setError(`The demo payment didn't go through: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  }, [order]);

  const copy = useCallback(async () => {
    if (order === undefined) return;
    await navigator.clipboard.writeText(order.uri);
    setCopied(true);
  }, [order]);

  return (
    <div className="layout">
      <section className="menu" aria-labelledby="menu-heading">
        <h2 id="menu-heading">Menu</h2>
        {menu === undefined && error === undefined && <p className="quiet">Loading the menu…</p>}
        <ul>
          {menu?.items.map((item) => (
            <li key={item.id} className="row">
              <div>
                <h3>{item.name}</h3>
                <p className="quiet">{item.description}</p>
              </div>
              <span className="price">{item.price} SOL</span>
              <button type="button" className="text-button" disabled={busy !== undefined} onClick={() => place(item.id)}>
                Order
              </button>
            </li>
          ))}
        </ul>
        {menu && (
          <p className="footnote">
            Network: {menu.cluster}. Prices are in SOL so the demo runs on a local validator.
          </p>
        )}
      </section>

      <aside
        className={`ticket${order?.status === "paid" ? " is-paid" : order?.status === "underpaid" ? " is-underpaid" : ""}`}
        aria-live="polite"
      >
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {order === undefined ? (
          <p className="quiet">Pick something from the menu to get a payment code.</p>
        ) : (
          <>
            <div className="ticket-head">
              <h2>{order.item}</h2>
              <p className="price">{order.price} SOL</p>
              <p className="quiet">Order {order.id}</p>
            </div>

            {order.status === "paid" ? (
              <div className="paid-note">
                <p className="paid-mark">Paid</p>
                <p>
                  {sol(order.received)} SOL received
                  {order.paidAt && ` at ${new Date(order.paidAt).toLocaleTimeString()}`}.
                </p>
                <p className="quiet">
                  Matched by the encrypted order number, transaction {short(order.payments.at(-1)?.signature ?? "")}.
                </p>
              </div>
            ) : (
              <>
                {qr && (
                  <div className="qr" role="img" aria-label="Payment code" dangerouslySetInnerHTML={{ __html: qr }} />
                )}
                <p className="status">
                  {order.status === "underpaid"
                    ? `Part paid: ${sol(order.received)} of ${order.price} SOL. Waiting for the rest.`
                    : "Waiting for payment…"}
                </p>
                <p className="quiet">Scan with a wallet that supports private payments, or copy the link.</p>
                <button type="button" className="text-button" onClick={copy}>
                  {copied ? "Payment link copied" : "Copy payment link"}
                </button>
              </>
            )}

            {menu?.demo && (
              <div className="demo">
                <h3>Demo customer</h3>
                {demo === undefined ? (
                  <>
                    <p className="quiet">No wallet handy? A funded local test wallet can pay this order.</p>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== undefined || order.status === "paid"}
                      onClick={payAsDemo}
                    >
                      {busy === "pay" ? "Paying…" : "Pay as demo customer"}
                    </button>
                  </>
                ) : (
                  <p>
                    Sent in transaction {short(demo.signature)}.{" "}
                    <a href={demo.verifierUrl} target="_blank" rel="noreferrer noopener">
                      Open the customer&apos;s receipt
                    </a>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
