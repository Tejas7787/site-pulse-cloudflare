import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const resp = await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  console.log("HTTP:", resp?.status());
  await page.waitForTimeout(2500);
  console.log("TITLE:", await page.title());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.screenshot({ path: "shot-landing.png", fullPage: false });
  console.log("console errors:", errors.length);
  console.log("SMOKE_OK");
} catch (err) {
  console.log("SMOKE_FAIL:", String(err).slice(0, 500));
} finally {
  await browser.close();
}
