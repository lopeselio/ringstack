import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/martian-mono/400.css";
import "@fontsource/martian-mono/600.css";
import "./style.css";

import { isAddress, type Address } from "@solana/kit";

import type { VerifiedOutput, VerifiedProof, VerifyResult } from "./verify.ts";

const form = document.querySelector<HTMLFormElement>("#check")!;
const linkInput = document.querySelector<HTMLTextAreaElement>("#link")!;
const ownerInput = document.querySelector<HTMLInputElement>("#owner")!;
const submit = document.querySelector<HTMLButtonElement>("#submit")!;
const result = document.querySelector<HTMLElement>("#result")!;

const params = new URLSearchParams(location.search);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== undefined) el.append(c);
  return el;
}

const short = (s: string, n = 4) => (s.length <= 2 * n + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

const STAMP: Record<VerifiedOutput["commitment"], { text: string; note: string }> = {
  verified: { text: "Matches chain", note: "Amount and asset match the onchain commitment." },
  mismatch: {
    text: "Doesn't match",
    note: "The encrypted amount differs from what was committed onchain. Don't accept this receipt.",
  },
  unchecked: {
    text: "Not checked",
    note: "The recipient isn't in the registry, so the amount couldn't be matched to the chain. Enter their address to check it.",
  },
};

function explorerUrl(r: { cluster: string; signature: string; endpoints: { rpcUrl: string } }): string {
  const base = `https://explorer.solana.com/tx/${r.signature}`;
  if (r.cluster === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(r.endpoints.rpcUrl)}`;
}

function txMeta(cluster: string, slot: bigint, link: HTMLElement): HTMLElement {
  return h(
    "dl",
    { class: "meta" },
    h("dt", {}, "Network"),
    h("dd", {}, cluster),
    h("dt", {}, "Slot"),
    h("dd", {}, slot.toString()),
    h("dt", {}, "Transaction"),
    h("dd", {}, link),
  );
}

function renderProof(p: VerifiedProof): HTMLElement {
  return h(
    "article",
    { class: "slip", "aria-label": "Payment proof" },
    h("h2", {}, "Proof of payment"),
    txMeta(
      p.cluster,
      p.slot,
      h("a", { href: explorerUrl(p), target: "_blank", rel: "noreferrer noopener" }, short(p.signature, 6)),
    ),
    h(
      "ol",
      { class: "lines" },
      h(
        "li",
        { class: "line verified" },
        h("p", { class: "to" }, h("span", { title: p.owner }, `Paid to ${short(p.owner, 6)}`)),
        h("p", { class: "amount" }, p.amount, " ", h("span", { class: "unit" }, p.symbol)),
        p.memo === undefined ? undefined : h("p", { class: "memo" }, "Memo ", h("q", {}, p.memo)),
        h("p", { class: "stamp", title: STAMP.verified.note }, STAMP.verified.text),
        p.registered
          ? undefined
          : h("p", { class: "note" }, "The payee's current registry entry has different keys, so who they are can't be confirmed from the registry."),
      ),
    ),
    h(
      "p",
      { class: "footer" },
      "The payee proved this one output. Nothing else in the transaction, including anyone else paid in it, is revealed.",
    ),
  );
}

function renderOutput(o: VerifiedOutput, you: Address | undefined): HTMLElement {
  const isYou = you !== undefined && o.owner === you;
  const who = o.owner === undefined ? `viewing key ${short(o.viewingKey, 6)}` : short(o.owner, 6);
  const stamp = STAMP[o.commitment];
  return h(
    "li",
    { class: `line ${o.commitment}${isYou ? " you" : ""}` },
    h(
      "p",
      { class: "to" },
      isYou ? h("span", { title: o.owner ?? "" }, "Paid to you") : h("span", { title: o.owner ?? o.viewingKey }, `Paid to ${who}`),
    ),
    h("p", { class: "amount" }, o.amount, " ", h("span", { class: "unit" }, o.symbol)),
    o.memo === undefined ? undefined : h("p", { class: "memo" }, "Memo ", h("q", {}, o.memo)),
    h("p", { class: "stamp", title: stamp.note }, stamp.text),
    o.commitment === "verified" ? undefined : h("p", { class: "note" }, stamp.note),
  );
}

function renderSlip(r: VerifyResult, you: Address | undefined): HTMLElement {
  const outputs = [...r.outputs].sort((a, b) => Number(b.owner === you) - Number(a.owner === you));
  return h(
    "article",
    { class: "slip", "aria-label": "Receipt" },
    h("h2", {}, "Private payment"),
    txMeta(
      r.receipt.cluster,
      r.slot,
      h(
        "a",
        { href: explorerUrl({ cluster: r.receipt.cluster, signature: r.receipt.signature, endpoints: r.endpoints }), target: "_blank", rel: "noreferrer noopener" },
        short(r.receipt.signature, 6),
      ),
    ),
    r.outputs.length === 0
      ? h("p", { class: "empty" }, "This transaction has no outputs the receipt can open.")
      : h("ol", { class: "lines" }, ...outputs.map((o) => renderOutput(o, you))),
    h(
      "p",
      { class: "footer" },
      "Who sent the payment isn't part of the receipt. Memos are readable by the recipient and anyone holding this receipt.",
    ),
    r.registryError === undefined
      ? undefined
      : h("p", { class: "footer" }, `Couldn't read the address registry (${r.registryError}).`),
  );
}

function showError(message: string) {
  result.replaceChildren(h("p", { class: "error", role: "alert" }, message));
}

async function check(link: string, owner: string) {
  if (link.trim() === "") return showError("Paste a receipt (ringrcpt1:…) or a payment proof (ringproof1:…).");
  const you = owner.trim() === "" ? undefined : owner.trim();
  if (you !== undefined && !isAddress(you)) return showError("That isn't a Solana address. Check it and try again.");

  submit.disabled = true;
  submit.textContent = "Checking…";
  result.replaceChildren(h("p", { class: "pending" }, "Loading the transaction and decrypting it…"));
  try {
    // The SDK (hasher WASM included) is most of the bundle; load it on first use.
    const { verifyProofLink, verifyReceipt } = await import("./verify.ts");
    if (link.trim().startsWith("ringproof1:")) {
      const p = await verifyProofLink(link, { params });
      result.replaceChildren(renderProof(p));
    } else {
      const r = await verifyReceipt(link, { params, ...(you === undefined ? {} : { owners: [you] }) });
      result.replaceChildren(renderSlip(r, you));
    }
    history.replaceState(null, "", `${location.pathname}${location.search}#${link.trim()}`);
  } catch (e) {
    const err = e as Error;
    showError(err.name === "VerifyError" ? err.message : `Something went wrong: ${err.message}`);
  } finally {
    submit.disabled = false;
    submit.textContent = "Check payment";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void check(linkInput.value, ownerInput.value);
});

// A receipt in the fragment (never sent to a server) is checked on load.
const fromHash = decodeURIComponent(location.hash.slice(1));
const to = params.get("to");
if (to !== null) ownerInput.value = to;
if (fromHash.startsWith("ringrcpt1:") || fromHash.startsWith("ringproof1:")) {
  linkInput.value = fromHash;
  void check(fromHash, ownerInput.value);
}
