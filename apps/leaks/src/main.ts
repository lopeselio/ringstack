import "@fontsource-variable/archivo/wdth.css";
import "./style.css";

import type { Bucket, LeakStats } from "@ringstack/leakscan";

const app = document.querySelector<HTMLElement>("#app")!;

type Reason = "amount" | "roundtrip" | "reuse" | "none";
const REASONS: { key: Reason; stat: keyof LeakStats["byMainReason"]; label: string; explain: string }[] = [
  {
    key: "amount",
    stat: "uniqueAmount",
    label: "Unique amount",
    explain: "Exactly one recent deposit had this amount, so the amount alone points to it.",
  },
  {
    key: "roundtrip",
    stat: "roundTrip",
    label: "Round trip",
    explain: "The money went back to an address that had deposited into the pool.",
  },
  {
    key: "reuse",
    stat: "recipientReuse",
    label: "Reused recipient",
    explain: "The address had already received a withdrawal, which ties the two together.",
  },
  {
    key: "none",
    stat: "notLinked",
    label: "Not linked",
    explain: "None of these signals applies.",
  },
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`);
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }) : "–";
const sol = (n: number) => n.toLocaleString("en", { maximumFractionDigits: 9 });
const days = (s: LeakStats) =>
  s.from && s.to ? Math.max(1, Math.round((Date.parse(s.to) - Date.parse(s.from)) / 86_400_000)) : 0;

function bars(buckets: readonly Bucket[], unit: string): string {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return `<div class="bars">${buckets
    .map(
      (b) => `<div class="row" data-tip="${esc(`${b.label}: ${b.count} ${unit}`)}">
        <span>${esc(b.label)}</span>
        <span class="track"><span class="fill" style="width:${(100 * b.count) / max}%"></span></span>
        <span class="n">${b.count}</span>
      </div>`,
    )
    .join("")}</div>`;
}

function render(s: LeakStats) {
  const total = s.totals.withdrawals;
  const linked = s.withdrawals.linkable;
  const span = days(s);

  // One dot per withdrawal, grouped by its strongest link.
  let i = 0;
  const dots = REASONS.flatMap(({ key, stat }) =>
    Array.from({ length: s.byMainReason[stat] }, () => `<span class="dot" data-r="${key}" style="--i:${i++}"></span>`),
  ).join("");

  const legend = REASONS.map(
    ({ key, stat, label }) => `<li><button type="button" data-r="${key}" aria-pressed="false">
      <span class="swatch" style="background:var(--r-${key})"></span>
      ${label} <b>${s.byMainReason[stat]}</b></button></li>`,
  ).join("");

  const reasonCards = REASONS.slice(0, 3)
    .map(({ key, label, explain }) => {
      const n =
        key === "amount" ? s.withdrawals.uniqueAmountMatch : key === "roundtrip" ? s.withdrawals.roundTrip : s.withdrawals.recipientReuse;
      return `<div class="reason">
        <dt><span class="swatch" style="background:var(--r-${key})"></span>${label}<span class="share">${pct(n, total)}</span></dt>
        <div class="meter" aria-hidden="true"><span style="width:${pct(n, total)};background:var(--r-${key})"></span></div>
        <dd>${explain} ${n} of ${total} withdrawals.</dd>
      </div>`;
    })
    .join("");

  const dayMax = Math.max(1, ...s.daily.map((d) => d.deposits + d.withdrawals));
  const daily = s.daily
    .map(
      (d) => `<div class="day" data-tip="${esc(`${fmtDate(d.day)}: ${d.deposits} deposits, ${d.withdrawals} withdrawals`)}">
        <span class="seg w" style="height:${(100 * d.withdrawals) / dayMax}%"></span>
        <span class="seg d" style="height:${(100 * d.deposits) / dayMax}%"></span>
      </div>`,
    )
    .join("");

  const amounts = s.commonDepositAmounts
    .map((a) => `<tr><td>${sol(a.sol)} SOL</td><td class="num">${a.count}</td></tr>`)
    .join("");

  const dailyTable = s.daily
    .map(
      (d) =>
        `<tr><td>${fmtDate(d.day)}</td><td class="num">${d.deposits}</td><td class="num">${d.withdrawals}</td><td class="num">${pct(Math.round(d.uniqueMatchShare * d.withdrawals), d.withdrawals)}</td></tr>`,
    )
    .join("");

  app.innerHTML = `
  <header class="hero">
    <p class="scope">Helius shielded pool on ${esc(s.network)}, ${fmtDate(s.from)} to ${fmtDate(s.to)} (${span} ${span === 1 ? "day" : "days"})</p>
    <h1>${linked} of ${total} withdrawals could be traced from public data.</h1>
    <p class="lede">Deposits into the pool and withdrawals out of it are public: anyone can see the address and the amount. Payments inside the pool are not. Each dot below is one withdrawal, coloured by the strongest public link it has to a deposit or to another withdrawal.</p>
    <div class="field" role="img" aria-label="${esc(
      REASONS.map(({ stat, label }) => `${label}: ${s.byMainReason[stat]}`).join(", "),
    )}">${dots}</div>
    <ul class="legend" aria-label="Highlight withdrawals by reason">${legend}</ul>
  </header>

  <section>
    <h2>What gives withdrawals away</h2>
    <p>A withdrawal can show more than one of these, so the shares can add up to more than the total linked.</p>
    <dl class="reasons">${reasonCards}</dl>
  </section>

  <section>
    <h2>How big is the crowd</h2>
    <p>Before amounts or addresses are considered, a withdrawal could have come from any earlier deposit: a median of <strong>${s.medianNaiveSet}</strong> deposits. Matching the exact amount within ${s.windowHours / 24} days shrinks that crowd, sometimes to one.</p>
    <div class="charts">
      <figure>
        <figcaption>Earlier deposits with the same amount</figcaption>
        <p>Withdrawals by how many deposits of the exact same amount came before them. Zero is safest; one is a direct match.</p>
        ${bars(s.exactSetSizes, "withdrawals")}
      </figure>
      <figure>
        <figcaption>Time since the matching deposit</figcaption>
        <p>For withdrawals that match a deposit's amount: how long the money stayed in the pool.</p>
        ${bars(s.matchDelayHours, "withdrawals")}
      </figure>
    </div>
  </section>

  <section>
    <h2>Activity</h2>
    <p>Deposits and withdrawals per day. More activity means a bigger crowd to blend into.</p>
    <div class="charts">
      <figure>
        <figcaption>Per day</figcaption>
        <ul class="legend" aria-hidden="true" style="margin-bottom:12px">
          <li><span style="display:inline-flex;gap:8px;align-items:center;font-size:15px;color:var(--text-2)"><span class="swatch" style="background:var(--bar)"></span>Deposits</span></li>
          <li><span style="display:inline-flex;gap:8px;align-items:center;font-size:15px;color:var(--text-2)"><span class="swatch" style="background:var(--act-w)"></span>Withdrawals</span></li>
        </ul>
        <div class="daily" role="img" aria-label="Deposits and withdrawals per day; see the table below">${daily}</div>
        <div class="axis"><span>${fmtDate(s.daily[0]?.day ?? null)}</span><span>${fmtDate(s.daily.at(-1)?.day ?? null)}</span></div>
        <details><summary>Show as a table</summary>
          <table><thead><tr><th>Day</th><th class="num">Deposits</th><th class="num">Withdrawals</th><th class="num">Unique amount</th></tr></thead><tbody>${dailyTable}</tbody></table>
        </details>
      </figure>
      <figure>
        <figcaption>Common deposit amounts</figcaption>
        <p>Withdrawing one of these amounts blends in with many deposits.</p>
        <table><thead><tr><th>Amount</th><th class="num">Deposits</th></tr></thead><tbody>${amounts}</tbody></table>
      </figure>
    </div>
  </section>

  <section>
    <h2>Before you withdraw</h2>
    <ul class="advice">
      <li><strong>Use a fresh address</strong>Never withdraw to an address that deposited, or that already received a withdrawal.</li>
      <li><strong>Avoid your deposit amount</strong>Withdraw a different amount, or split it into amounts many others use.</li>
      <li><strong>Give it time</strong>Every deposit that lands before you withdraw grows the crowd you hide in.</li>
      <li><strong>Or stay inside</strong>Paying privately inside the pool reveals no amount and no address at all.</li>
    </ul>
    <p>The leakscan advisor checks a planned withdrawal against your own deposits. It runs on your machine, so your addresses never leave it.</p>
    <pre><code>pnpm --filter @ringstack/leakscan leakscan scan --days 7
pnpm --filter @ringstack/leakscan leakscan advise \\
  --amount 1.2 --recipient &lt;address&gt; --mine &lt;your deposit addresses&gt;</code></pre>
  </section>

  <footer>
    <p>This page publishes totals only: no addresses and no transactions. It counts deposits and withdrawals of SOL, read from successful pool transactions over public RPC. "Linked" means a public signal ties a withdrawal to a deposit or another withdrawal. It is not proof of who sent it, and a careful observer may find links that this misses.</p>
    <p>Devnet activity is mostly tests, including this project's own, so treat the numbers as a demonstration of the method. Updated ${esc(new Date(s.generatedAt).toUTCString())}. <a href="../">ringstack docs</a> · <a href="./stats.json">stats.json</a></p>
  </footer>`;

  wire();
}

function wire() {
  const field = app.querySelector<HTMLElement>(".field")!;
  const buttons = [...app.querySelectorAll<HTMLButtonElement>(".hero .legend button")];
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      for (const o of buttons) o.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", String(on));
      if (on) field.dataset["focus"] = b.dataset["r"]!;
      else delete field.dataset["focus"];
      for (const d of field.querySelectorAll<HTMLElement>(".dot")) d.classList.toggle("on", on && d.dataset["r"] === b.dataset["r"]);
    });
  }

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  document.body.append(tip);
  app.addEventListener("pointermove", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!t) return void (tip.hidden = true);
    tip.textContent = t.dataset["tip"]!;
    tip.hidden = false;
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  app.addEventListener("pointerleave", () => (tip.hidden = true));
}

try {
  const res = await fetch("./stats.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(String(res.status));
  render((await res.json()) as LeakStats);
} catch {
  app.innerHTML = `<p class="empty">No scan has been published yet. Run <code>leakscan scan</code> and <code>leakscan stats</code>, then put stats.json next to this page.</p>`;
}
