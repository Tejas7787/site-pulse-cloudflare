// Phase 9C browser tests — part 3: agency workspace. Create workspace, client
// plan cap (free = 3), invite link, invite acceptance permission message, and
// cross-user isolation between two separate signed-in accounts. Test data only.
import { chromium } from "playwright";
import { appendFileSync, mkdirSync } from "fs";

const BASE = "http://localhost:5173";
mkdirSync("shots", { recursive: true });
const results = [];
function rec(id, status, detail = "") {
  results.push({ id, status, detail });
  console.log(`${status} ${id}${detail ? " :: " + detail : ""}`);
}
async function test(id, fn) {
  try {
    await fn();
  } catch (err) {
    rec(id, "FAIL", String(err).slice(0, 300));
  }
}

const browser = await chromium.launch();

async function newGuestPage(returnTo) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(`${BASE}/auth?returnTo=${encodeURIComponent(returnTo)}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /Continue as Guest/ }).click();
  await p.waitForURL(new RegExp(returnTo.replace(/\//g, "\\/")), { timeout: 15000 });
  return { c, p };
}

// ── Account A: workspace + clients + limits + invite ────────────────────────
const { p: a } = await newGuestPage("/agency");
let inviteLink = null;

await test("agency-create-workspace", async () => {
  await a.getByPlaceholder("Agency name (e.g. Northwind Digital)").fill("E2E Test Agency");
  await a.getByRole("button", { name: /Create workspace/ }).click();
  // Workspace dashboard appears (stats/limits for the free plan).
  await a.getByText(/Active clients/i).waitFor({ timeout: 15000 });
  await a.screenshot({ path: "shots/w5-agency-created.png", fullPage: true });
  rec("agency-create-workspace", "PASS");
});

await test("agency-client-cap-enforced-with-readable-error", async () => {
  for (let i = 1; i <= 3; i += 1) {
    await a.getByPlaceholder("Client name").fill(`E2E Client ${i}`);
    await a.getByRole("button", { name: "Add", exact: true }).click();
    await a.getByText(`E2E Client ${i}`).first().waitFor({ timeout: 15000 });
  }
  // 4th client must hit the free-plan cap (3) — record the EXACT error text
  // to check it is user-readable (not a raw JSON ConvexError dump).
  await a.getByPlaceholder("Client name").fill("E2E Client 4");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await a.getByText(/Workspace limit: 3 active clients/).first().waitFor({ timeout: 15000 });
  await a.screenshot({ path: "shots/w5-agency-limit.png", fullPage: false });
  // Phase 9C fix check: the cap error is the authored sentence — the raw
  // Convex wrapper (JSON/request id/internal path) must never be visible.
  const body = await a.locator("body").innerText();
  if (/\[CONVEX|"code":|at handler/.test(body)) throw new Error("raw framework error shown to user");
  const clients = [...new Set(body.match(/E2E Client \d/g) ?? [])];
  if (clients.length !== 3) throw new Error(`expected exactly 3 clients, saw ${clients.length}`);
  rec("agency-client-cap-enforced-with-readable-error", "PASS", "cap enforced; friendly message; no internals");
});

await test("agency-invite-creates-shareable-link", async () => {
  const emailInput = a.locator('input[type="email"], input[placeholder*="mail" i]').first();
  await emailInput.fill("teammate-e2e@example.com");
  await a.getByRole("button", { name: /invite/i }).first().click();
  // The one-time invite link appears (token shown once to the owner).
  const link = await a
    .getByText(/\/agency\?invite=/)
    .first()
    .innerText()
    .catch(() => null);
  const fallback = await a.locator("body").innerText();
  const m = (link ?? fallback).match(/https?:\/\/\S*\/agency\?invite=[0-9a-f]+/) ?? fallback.match(/\/agency\?invite=([0-9a-f]+)/);
  if (!m) throw new Error(`invite link not shown: ${(link ?? fallback).slice(0, 200)}`);
  inviteLink = m[0].startsWith("http") ? m[0] : `${BASE}${m[0]}`;
  if (!/teammate-e2e@example\.com/.test(fallback)) throw new Error("invited email not listed");
  rec("agency-invite-creates-shareable-link", "PASS", inviteLink.replace(/[0-9a-f]{32,}/, "<token>…"));
});

// ── Account B (separate signed-in user): isolation + invite permission ──────
const { p: b } = await newGuestPage("/agency");

await test("cross-user-agency-isolation", async () => {
  await b.getByPlaceholder("Agency name (e.g. Northwind Digital)").waitFor({ timeout: 15000 });
  const body = await b.locator("body").innerText();
  if (/E2E Test Agency|E2E Client 1/i.test(body)) throw new Error("account A's workspace leaked to account B");
  await b.screenshot({ path: "shots/w5-cross-user-isolated.png", fullPage: false });
  rec("cross-user-agency-isolation", "PASS", "B sees only the create-workspace state");
});

await test("invite-acceptance-requires-invited-account", async () => {
  if (!inviteLink) throw new Error("no invite link from earlier test");
  await b.goto(inviteLink, { waitUntil: "domcontentloaded" });
  // Preview shows the invitation to the invited address.
  await b.getByText(/teammate-e2e@example\.com/).first().waitFor({ timeout: 15000 });
  await b.getByRole("button", { name: /accept/i }).first().click();
  // B is a different (anonymous) account → honest wrong-account refusal.
  const refusal = b.getByText(/sent to teammate-e2e@example\.com|Sign in with that account/i);
  await refusal.first().waitFor({ timeout: 15000 });
  const body = await b.locator("body").innerText();
  await b.screenshot({ path: "shots/w5-invite-refused.png", fullPage: false });
  rec(
    "invite-acceptance-requires-invited-account",
    /"code"|^\{/.test(body) ? "BUG" : "PASS",
    "wrong-account refusal shown",
  );
});

appendFileSync("results.jsonl", results.map((r) => JSON.stringify(r)).join("\n") + "\n");
await browser.close();
console.log("PART3_DONE");
