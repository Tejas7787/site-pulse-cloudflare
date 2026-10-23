// Phase 9C late poll: the monitor created in part 5 should now have been
// probed by the every-5-minutes dispatch cron. Restores the saved session,
// waits (bounded) for a real probe result to render, checks the uptime
// insights block labels honestly, and asserts no Convex wrapper leaks.
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices["iPhone 13"],
  storageState: "session-state.json",
});
const page = await ctx.newPage();

const leaks = [];
page.on("console", (m) => {
  if (m.text().includes("[CONVEX")) leaks.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => leaks.push(String(e).slice(0, 200)));

let pass = 0;
let fail = 0;
function rec(name, status, detail = "") {
  const line = `${status}  ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (status === "PASS") pass++;
  else fail++;
}
async function test(name, fn) {
  try {
    await fn();
    rec(name, "PASS");
  } catch (err) {
    rec(name, "FAIL", String(err).slice(0, 300));
  }
}

await page.goto(`${BASE}/monitors`, { waitUntil: "domcontentloaded" });
await page.getByText("Uptime monitors").waitFor({ timeout: 15000 });

// 1. Wait (up to ~150s, cron is every 5 min) for the monitor row to show a
// probe-driven state instead of the never-checked placeholder.
await test("latepoll-probe-ran", async () => {
  const deadline = Date.now() + 150_000;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await page.locator("body").innerText();
    // A probe result renders either a status pill with uptime/response data
    // or an incident; "No checks yet" means the cron has not ticked.
    if (!/no checks yet|waiting for the first check/i.test(seen)) return;
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.getByText("Uptime monitors").waitFor({ timeout: 15000 }).catch(() => {});
  }
  throw new Error("monitor still shows no checks after 150s");
});

// 2. Uptime insights render with honest labeling (7/30-day windows).
// The insights live in the collapsed per-monitor Details panel — expand it.
await test("latepoll-insights-render", async () => {
  await page.getByRole("button", { name: /Details/i }).first().click();
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  // Charts + windows are present.
  if (!/uptime · last 7 days/i.test(body) || !/uptime · last 30 days/i.test(body)) {
    throw new Error("7-day or 30-day uptime window missing");
  }
  if (!/Response time/i.test(body) || !/Incident history/i.test(body)) {
    throw new Error("response-time trend or incident history missing");
  }
  // With 1 check the label must disclose coverage rather than pretend.
  if (!/partial coverage|not enough data|insufficient/i.test(body)) {
    throw new Error("single-check window not labeled with coverage caveat");
  }
  if (!/uptime/i.test(body)) throw new Error("no uptime section");
  // Either a real percentage or an explicit insufficient-data label — never
  // an invented number with no checks behind it.
  const hasPct = /\d+(\.\d+)?\s*%/.test(body);
  if (!hasPct) throw new Error("uptime insights show no percentage at all");
});

// 3. No raw Convex/internal errors surfaced anywhere on the page.
await test("latepoll-no-error-leaks", async () => {
  const body = await page.locator("body").innerText();
  if (/\[CONVEX|ConvexError|instanceof Error|request id/i.test(body)) {
    throw new Error("raw error text on page: " + body.match(/.{0,120}(\[CONVEX|ConvexError|request id).{0,120}/)?.[0]);
  }
  if (leaks.length) throw new Error("console leaks: " + leaks[0]);
});

await ctx.close();
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
