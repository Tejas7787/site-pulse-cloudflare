import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const sent = [];
const recv = [];
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => sent.push(String(f.payload ?? "")));
  ws.on("framereceived", (f) => recv.push(String(f.payload ?? "")));
});

await page.goto(`${BASE}/auth?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Continue as Guest/ }).click();
await page.waitForURL(/\/dashboard/, { timeout: 15000 });

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.fill("#website-url", "https://example.com");
await page.getByRole("button", { name: /Scan Website/ }).click();
await page.waitForURL(/\/report\/.+/, { timeout: 90000 });

const propose = page.getByRole("button", { name: /Propose fixes for this report/ });
await propose.waitFor({ timeout: 20000 });
await propose.click();
await page.getByText("GitHub Repair", { exact: false }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(8000);

// Which queryIds were used for github:getConnection?
const connIds = new Set();
for (const s of sent) {
  if (s.includes("github:getConnection")) {
    for (const m of s.matchAll(/"queryId":(\d+)/g)) connIds.add(Number(m[1]));
  }
}
console.log("getConnection queryIds:", [...connIds]);

// Any received frame referencing those ids (success or error)?
let found = false;
for (const r of recv) {
  for (const id of connIds) {
    if (r.includes(`"queryId":${id}`)) {
      found = true;
      console.log(`RECV for queryId ${id}: ${r.slice(0, 500)}`);
    }
  }
}
if (!found) console.log("NO RESPONSE EVER RECEIVED for github:getConnection");

// Also dump every distinct received message type once.
const types = new Set();
for (const r of recv) {
  const t = r.match(/"type":"([A-Za-z]+)"/);
  types.add(t ? t[1] : "other");
}
console.log("received message types:", [...types]);

await browser.close();
console.log("DIAG4_DONE");
