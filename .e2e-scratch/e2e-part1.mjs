// Phase 9C browser tests — part 1: auth, scanning, report, Website Doctor,
// Repair/GitHub UI, SSRF error handling, history, logout.
// Real Chromium against the running app; test data only (example.com, safe
// test emails). Results append to results.jsonl.
import { chromium } from "playwright";
import { appendFileSync, mkdirSync } from "fs";

const BASE = "http://localhost:5173";
const SHOTS = "shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];

function rec(id, status, detail = "") {
  results.push({ id, status, detail });
  console.log(`${status} ${id}${detail ? " :: " + detail : ""}`);
}
function shot(page, name) {
  return page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 200)}`);
});

async function test(id, fn) {
  try {
    await fn();
  } catch (err) {
    rec(id, "FAIL", String(err).slice(0, 300));
  }
}

// ── W1: signed-out redirects ────────────────────────────────────────────────

await test("auth-dashboard-redirects-to-auth", async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth/, { timeout: 15000 });
  const url = new URL(page.url());
  const returnTo = url.searchParams.get("returnTo");
  if (returnTo !== "/dashboard") throw new Error(`returnTo=${returnTo}, url=${page.url()}`);
  rec("auth-dashboard-redirects-to-auth", "PASS", page.url());
});

await test("auth-pricing-redirects-to-auth", async () => {
  await page.goto(`${BASE}/pricing`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth/, { timeout: 15000 });
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  if (returnTo !== "/pricing") throw new Error(`returnTo=${returnTo}`);
  rec("auth-pricing-redirects-to-auth", "PASS", page.url());
});

// ── W1: email OTP up to code delivery (completion needs an inbox) ───────────

await test("auth-email-otp-code-step", async () => {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', "e2e-phase9c@example.com");
  await page.press('input[name="email"]', "Enter");
  // The platform OTP gateway only mails its designated testing address, so a
  // normal address fails server-side. The form must show the FRIENDLY error —
  // never the raw Convex stack (regression check for the Phase 9C fix).
  const friendly = page.getByText(/couldn't send your sign-in code/i);
  const codeStep = page.getByText("Check your email");
  await Promise.race([
    friendly.first().waitFor({ timeout: 20000 }),
    codeStep.first().waitFor({ timeout: 20000 }),
  ]).catch(() => {});
  const body = await page.locator("body").innerText();
  if (/\[CONVEX/.test(body)) throw new Error("raw Convex stack shown to the user");
  if (!/couldn't send your sign-in code|Check your email/.test(body)) {
    throw new Error(`neither friendly error nor code step: ${body.slice(0, 300)}`);
  }
  await shot(page, "w1-auth-otp-step");
  rec(
    "auth-email-otp-code-step",
    "PASS",
    /Check your email/.test(body)
      ? "code step visible; completion BLOCKED (no inbox)"
      : "friendly error shown, no raw stack (OTP gateway limits recipients to its testing address)",
  );
});

// ── W1: guest sign-in + persistence ────────────────────────────────────────

await test("auth-guest-login", async () => {
  await page.goto(`${BASE}/auth?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Continue as Guest/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.getByText("Authenticated workspace").waitFor({ timeout: 15000 });
  await shot(page, "w1-dashboard");
  rec("auth-guest-login", "PASS", page.url());
});

await test("auth-session-persists-across-reload", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.getByText("Authenticated workspace").waitFor({ timeout: 15000 });
  rec("auth-session-persists-across-reload", "PASS");
});

// ── W2: scan end-to-end (real fetch to example.com) ────────────────────────

let reportUrl = null;
await test("scan-completes-and-opens-report", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.fill("#website-url", "https://example.com");
  await page.getByRole("button", { name: /Scan Website/ }).click();
  await page.waitForURL(/\/report\/.+/, { timeout: 90000 });
  reportUrl = page.url();
  await page.getByText("Scan Summary").waitFor({ timeout: 30000 });
  await shot(page, "w2-report");
  rec("scan-completes-and-opens-report", "PASS", reportUrl);
});

await test("report-renders-core-sections", async () => {
  if (!reportUrl) throw new Error("no report url from previous test");
  await page.goto(reportUrl, { waitUntil: "domcontentloaded" });
  for (const heading of ["Scan Summary", "AI Website Doctor", "Fix Recommendations", "Why Trust This Report?"]) {
    await page.getByText(heading, { exact: false }).first().waitFor({ timeout: 20000 });
  }
  const gradeText = await page.locator("body").innerText();
  if (!/\bGrade\b|\b[ABCDF]\b/.test(gradeText)) throw new Error("no grade visible");
  rec("report-renders-core-sections", "PASS");
});

// ── W4: Website Doctor + Fix Proposals + GitHub Repair UI ──────────────────

await test("doctor-diagnosis-runs", async () => {
  if (!reportUrl) throw new Error("no report url");
  await page.goto(reportUrl, { waitUntil: "domcontentloaded" });
  const btn = page.getByRole("button", { name: /Diagnose my report/ });
  await btn.waitFor({ timeout: 20000 });
  await btn.click();
  // Success shows a diagnosis ("Diagnose again"); a quota/refusal shows an
  // explanatory message. Either way the workflow must not crash or hang.
  const done = page.getByRole("button", { name: /Diagnose again/ });
  const quota = page.getByText(/limit reached|temporary|unavailable|Diagnosis limit/i);
  await Promise.race([done.waitFor({ timeout: 30000 }), quota.first().waitFor({ timeout: 30000 })]).catch(() => {});
  const state = (await done.count()) > 0 ? "diagnosed" : "other";
  await shot(page, "w4-doctor");
  if (state !== "diagnosed") {
    const txt = (await page.locator("body").innerText()).slice(0, 400);
    throw new Error(`doctor did not complete: ${txt}`);
  }
  rec("doctor-diagnosis-runs", "PASS");
});

await test("repair-agent-proposals-and-github-ui", async () => {
  if (!reportUrl) throw new Error("no report url");
  await page.goto(reportUrl, { waitUntil: "domcontentloaded" });
  const propose = page.getByRole("button", { name: /Propose fixes for this report/ });
  await propose.waitFor({ timeout: 20000 });
  await propose.click();
  // Proposal result → GitHub Repair block appears (proposals are generated
  // deterministically for free; nothing external runs).
  await page.getByText("GitHub Repair", { exact: false }).first().waitFor({ timeout: 30000 });
  // Wait for the connection query to RESOLVE (it starts as "Checking …"):
  // configured → Connect button; unconfigured → honest notice.
  await Promise.race([
    page.getByText(/not configured on this deployment/i).first().waitFor({ timeout: 20000 }),
    page.getByRole("button", { name: /Connect GitHub/ }).first().waitFor({ timeout: 20000 }),
  ]).catch(() => {});
  const body = await page.locator("body").innerText();
  // This deployment has no GitHub OAuth config: the UI must show the honest
  // not-configured state (no Connect button is offered) …
  const unconfigured = /not configured on this deployment/i.test(body);
  // … and the writes-disabled notice must always be visible.
  const writesDisabled = /disabled on this deployment/i.test(body);
  const proposalsOk = /Proposed snippet|copy-paste proposal/i.test(body);
  await shot(page, "w7-github-repair");
  if (!proposalsOk) throw new Error("no proposals rendered");
  if (!unconfigured) throw new Error("no honest GitHub not-configured state");
  if (!writesDisabled) throw new Error("no writes-disabled notice visible");
  rec("repair-agent-proposals-and-github-ui", "PASS", "proposals ok; GitHub unconfigured honest state; writes-disabled notice ok");
});

// ── W2/launch-blocker: unsafe URL fetching refused in-browser ──────────────

await test("ssrf-private-address-refused", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.fill("#website-url", "http://127.0.0.1:5173/");
  await page.getByRole("button", { name: /Scan Website/ }).click();
  const err = page.getByText(/private or restricted address/i);
  await err.first().waitFor({ timeout: 20000 });
  if (/\/report\//.test(page.url())) throw new Error("navigated to a report despite refusal");
  // Phase 9C fix check: the error shown must be the authored sentence, never
  // the wrapped Convex server error (path/request-id leak).
  const errBody = await page.locator("body").innerText();
  if (/\[CONVEX|at handler/.test(errBody)) throw new Error("raw framework error shown to user");
  rec("ssrf-private-address-refused", "PASS", "blocked before fetch; friendly error only");
});

await test("scan-dns-failure-shows-honest-error", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.fill("#website-url", "https://no-such-host-987654321.example/");
  await page.getByRole("button", { name: /Scan Website/ }).click();
  const err = page.getByText(/Could not resolve/i);
  await err.first().waitFor({ timeout: 25000 });
  const errBody = await page.locator("body").innerText();
  if (/\[CONVEX|at handler/.test(errBody)) throw new Error("raw framework error shown to user");
  rec("scan-dns-failure-shows-honest-error", "PASS");
});

// ── W2: scan history ───────────────────────────────────────────────────────

await test("scan-history-shows-prior-scan", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("View scan history").click();
  const history = page.locator("#scan-history");
  await history.waitFor({ timeout: 10000 });
  const txt = await history.innerText();
  if (!/example\.com/.test(txt)) throw new Error(`history missing example.com: ${txt.slice(0, 200)}`);
  await shot(page, "w2-history");
  rec("scan-history-shows-prior-scan", "PASS");
});

// ── W1: logout + post-logout protection ────────────────────────────────────

await test("logout-ends-session-and-protects-routes", async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.getByText("Authenticated workspace").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: /Sign out/ }).click();
  await page.waitForURL(/\/$/, { timeout: 15000 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth/, { timeout: 15000 });
  rec("logout-ends-session-and-protects-routes", "PASS", "signed out → /, /dashboard → /auth");
});

rec("part1-console-errors", "INFO", `${consoleErrors.length} captured: ${consoleErrors.slice(0, 5).join(" | ")}`);
appendFileSync("results.jsonl", results.map((r) => JSON.stringify(r)).join("\n") + "\n");
await browser.close();
console.log("PART1_DONE");
