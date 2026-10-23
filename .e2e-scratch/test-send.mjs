// ── SitePulse: authenticated Resend test email (ONE authorized send) ─────────
// Modes:
//   node test-send.mjs check
//       Signs in (guest) and proves the authenticated invocation path works
//       by calling a read-only query. Sends NOTHING.
//   node test-send.mjs send <recipient@example.com>
//       Invokes the authenticated, quota-bounded alerts:sendTestEmail action
//       EXACTLY ONCE as the signed-in operator session. Run only after the
//       operator has explicitly authorized the send to that address.
//
// Safety: the API key lives only on the Convex deployment and is used
// server-side; this script never reads or prints it. The session JWT is used
// for authentication but never printed (only its presence/length).
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api.js";

const DEPLOYMENT_URL = "https://adorable-hyena-411.convex.cloud";
const JWT_STORAGE_KEY =
  "__convexAuthJWT_httpsadorablehyena411convexcloud";
const BASE = "http://localhost:5173";

const mode = process.argv[2];
const recipient = process.argv[3];

if (mode !== "check" && mode !== "send") {
  console.error("usage: node test-send.mjs check | send <recipient>");
  process.exit(2);
}
if (mode === "send" && !recipient) {
  console.error("send mode requires an explicit recipient address");
  process.exit(2);
}

// 1. Obtain a signed-in Convex session JWT via the real UI (guest sign-in).
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Continue as Guest/ }).click();
await page.waitForURL(/dashboard/, { timeout: 20000 });
const jwt = await page.evaluate((k) => localStorage.getItem(k), JWT_STORAGE_KEY);
await ctx.close();
await browser.close();
if (!jwt) {
  console.error("FAIL: no session JWT after sign-in");
  process.exit(1);
}
console.log(`signed in (guest session JWT present, length ${jwt.length}; value not printed)`);

// 2. Authenticated Convex call with the operator's session token.
const client = new ConvexHttpClient(DEPLOYMENT_URL, { logger: false });
client.setAuth(jwt);

if (mode === "check") {
  const me = await client.query(api.users.currentUser, {});
  console.log("authenticated query result:", JSON.stringify({ authenticated: !!me, userId: me?._id ?? null }));
  if (!me) process.exit(1);
  console.log("CHECK OK — authenticated path ready. Nothing was sent.");
  process.exit(0);
}

// mode === "send" — EXACTLY ONE call of the quota-bounded test action.
console.log(`invoking alerts:sendTestEmail once → recipient: ${recipient}`);
try {
  const result = await client.action(api.alerts.sendTestEmail, { to: recipient });
  console.log("provider-backed result:", JSON.stringify(result));
  if (result?.ok) {
    console.log(`SEND OK — provider email id: ${result.providerId ?? "(none returned)"}`);
    process.exit(0);
  }
  console.error("SEND FAILED — provider refused; see result above (no secrets included)");
  process.exit(1);
} catch (err) {
  const data = err?.data ?? undefined;
  console.error("action refused:", JSON.stringify(data ?? String(err).slice(0, 300)));
  process.exit(1);
}
