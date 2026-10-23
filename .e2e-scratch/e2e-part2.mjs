// Phase 9C browser tests — part 2: uptime monitors. Creation, free-plan copy,
// auto-opened detail with honest "no data" insights, alert destination,
// server-side URL rejection, pause/resume. Test data only.
import { chromium } from "playwright";
import { appendFileSync, mkdirSync } from "fs";

const BASE = "http://localhost:5173";
mkdirSync("shots", { recursive: true });
const results = [];
const consoleErrors = [];

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 200)}`);
});

// Sign in as a fresh guest.
await page.goto(`${BASE}/auth?returnTo=%2Fmonitors`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Continue as Guest/ }).click();
await page.waitForURL(/\/monitors/, { timeout: 15000 });

await test("monitor-create-with-alert-email", async () => {
  await page.getByText("Uptime monitors").waitFor({ timeout: 15000 });
  await page.getByPlaceholder("https://example.com").fill("https://example.com");
  await page.locator('input[type="email"]').fill("alerts-test@example.com");
  await page.getByRole("button", { name: "Monitor", exact: true }).click();
  // Card + auto-opened detail panel.
  await page.getByText("example.com").first().waitFor({ timeout: 15000 });
  await page.getByText(/Free plan: up to \d+ monitors/).waitFor({ timeout: 15000 });
  await page.screenshot({ path: "shots/w3-monitor-created.png", fullPage: true });
  rec("monitor-create-with-alert-email", "PASS");
});

await test("monitor-insights-panel-honest-no-data", async () => {
  // Detail auto-opens after create; insights must render honest "no data"
  // labels — never an invented percentage.
  await page.getByText("Uptime", { exact: true }).first().waitFor({ timeout: 20000 });
  await page.getByText(/No response-time data in this window yet/).waitFor({ timeout: 20000 });
  await page.getByText(/No incidents recorded/).waitFor({ timeout: 20000 });
  const body = await page.locator("body").innerText();
  if (!/uptime · last 7 days/i.test(body)) throw new Error("no 7-day uptime stat");
  // Honest em-dash (no fabricated 100%): the "—" stat with "no checks yet".
  if (!/no checks yet/i.test(body)) throw new Error("expected 'no checks yet' label");
  if (/^100%$/m.test(body)) {
    // A bare 100% with zero checks would be an invented metric.
    throw new Error("invented 100% uptime with zero checks");
  }
  rec("monitor-insights-panel-honest-no-data", "PASS", "no fabricated metrics");
});

await test("monitor-alert-destination-recipient", async () => {
  const body = await page.locator("body").innerText();
  if (!/alerts-test@example\.com/.test(body)) throw new Error("alert email not shown");
  if (!/will receive downtime\/recovery alerts/i.test(body)) throw new Error("alert purpose copy missing");
  rec("monitor-alert-destination-recipient", "PASS");
});

await test("monitor-invalid-credentials-url-rejected", async () => {
  await page.getByPlaceholder("https://example.com").fill("http://user:pass@example.com");
  await page.getByRole("button", { name: "Monitor", exact: true }).click();
  // Server-side normalization refuses embedded credentials — the page must
  // show the returned error, not crash or silently no-op.
  const err = page.getByText(/valid website address|credentials/i);
  await err.first().waitFor({ timeout: 15000 });
  const count = await page.getByText("example.com").count();
  if (count < 1) throw new Error("monitor list disappeared after error");
  // Phase 9C fix check: the displayed error must be the authored sentence —
  // never the wrapped Convex server error with paths and request ids.
  const errBody = await page.locator("body").innerText();
  if (/\[CONVEX|at handler/.test(errBody)) throw new Error("raw framework error shown to user");
  rec("monitor-invalid-credentials-url-rejected", "PASS");
});

await test("monitor-pause-resume", async () => {
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByText("Resume").waitFor({ timeout: 10000 });
  const body = await page.locator("body").innerText();
  if (!/· paused/.test(body)) throw new Error("paused state not shown in subtitle");
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Pause" }).waitFor({ timeout: 10000 });
  rec("monitor-pause-resume", "PASS");
});

await test("monitor-list-limited-to-free-cap-display", async () => {
  const body = await page.locator("body").innerText();
  const m = body.match(/Free plan: up to (\d+) monitors/);
  if (!m) throw new Error("free plan cap copy missing");
  rec("monitor-list-limited-to-free-cap-display", "PASS", `cap copy = ${m[1]}`);
});

rec("part2-console-errors", "INFO", `${consoleErrors.length} captured: ${consoleErrors.slice(0, 3).join(" | ")}`);
appendFileSync("results.jsonl", results.map((r) => JSON.stringify(r)).join("\n") + "\n");
await browser.close();
console.log("PART2_DONE");
