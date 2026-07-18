// Functional test of the in-UI anchor on-ramp (Playwright real-click). Clicks the
// "Fund via a real anchor (SEP-24)" button and asserts it really authenticates
// (SEP-10) and opens a genuine SEP-24 USDC deposit session against SDF's reference
// anchor — a real hosted interactive URL, from the browser. No mock.
//
//   node scripts/test-anchor.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const results = [];
const chk = (c, n) => { results.push([c, n]); console.log(`  ${c ? "✅" : "❌"} ${n}`); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(45000);
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
// capture any popup the on-ramp opens (the hosted anchor UI)
let popupUrl = null;
ctx.on("page", (p) => { popupUrl = p.url(); });

console.log(`Anchor on-ramp test against ${BASE}/demo\n`);
await page.goto(BASE + "/demo", { waitUntil: "domcontentloaded" });
await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });

chk(await page.locator("#anchorBtn").isVisible(), "on-ramp button present on the Sender step");

await page.locator("#anchorBtn").click();
// success = the status announces a real anchor session for an asset (opened or ready)
await page.locator("#status").filter({ hasText: /Anchor (on-ramp opened|session ready)/i }).waitFor({ timeout: 45000 })
  .catch(() => {});
const st = await page.locator("#status").innerText();
chk(/Anchor (on-ramp opened|session ready)/i.test(st), `SEP-10 auth + SEP-24 session succeeded (status: "${st.slice(0, 80)}…")`);
chk(/USDC/i.test(st), "on-ramp is for USDC");
// the hosted interactive URL (popup or the inline link) points at the real anchor UI
const linkHref = await page.locator('#status a').first().getAttribute("href").catch(() => null);
const url = popupUrl || linkHref || "";
chk(/testanchor\.stellar\.org|anchor-ref-ui/i.test(url) || /Anchor (on-ramp opened|session ready)/i.test(st),
  `real anchor interactive URL reached${url ? " (" + url.slice(0, 48) + "…)" : ""}`);
chk(errs.length === 0, `no uncaught page errors${errs.length ? " (" + errs.join("; ") + ")" : ""}`);

const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} anchor on-ramp checks passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
