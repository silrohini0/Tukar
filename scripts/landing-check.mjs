// Landing-page QA (Playwright real-click). The landing page is a visitor's first
// impression, so this asserts it loads clean, its on-chain links point to the LIVE
// contracts, its footer links deep-link to the named doc/circuit (not just the repo
// root), and the primary CTA actually lands you in the working demo.
//
//   node scripts/landing-check.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/$/, "");
const results = [];
const ok = (n) => { results.push([true, n]); console.log(`  ✅ ${n}`); };
const bad = (n, w) => { results.push([false, `${n} — ${w}`]); console.log(`  ❌ ${n} — ${w}`); };
const tc = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message.split("\n")[0]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// the live deployment (deployments/testnet.json) — every stellar.expert contract
// link on the landing must point at one of these, never a superseded id.
const LIVE = new Set([
  "CD4CIE7IZSU5J7ZHVPQVEMYKO6CP7RTU3XT7TGUNUCOLKZGINVQZKFFS", // pool
  "CACSB6NBWKQNRLN7GODIUQ7JJBLDPSFDTS7J73ZSNWOXQWVWNFGKT5XD", // transfer
  "CCPQG73RUCO4TTNZAX2I2BJHFWWPFJI6KVMLLPMBZIAG5XQI3CT43MFP", // compliance
  "CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET", // disclosure
  "CD6WAS6UMLJRSVYO3V74VW2JDBTR3ENYIQIKX6FRNHVHMAI2AUQ4E3HY", // merkleUpdate
]);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(45000);
const errs = [];
page.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
page.on("requestfailed", (r) => { const u = r.url(); if (!/fonts\.gstatic|favicon/.test(u)) errs.push("[reqfail] " + u); });

console.log(`Landing QA against ${BASE}/\n`);
await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 60000 });

await tc("H1 states the value prop", async () => {
  const h1 = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ").trim();
  assert(/private in the middle/i.test(h1) && /accountable at the edges/i.test(h1), `H1: "${h1}"`);
});

await tc("all stellar.expert contract links point to LIVE contracts", async () => {
  const hrefs = await page.locator('a[href*="stellar.expert/explorer/testnet/contract/"]').evaluateAll(
    (as) => as.map((a) => a.getAttribute("href")));
  assert(hrefs.length > 0, "no contract links found");
  for (const h of hrefs) {
    const id = h.split("/contract/")[1].split(/[/?#]/)[0];
    assert(LIVE.has(id), `link to non-live contract: ${id}`);
  }
  console.log(`     ${hrefs.length} contract link(s), all live`);
});

await tc("footer links deep-link to the named doc/circuit (not the repo root)", async () => {
  for (const label of ["Architecture", "On-chain", "Testing", "transfer", "compliance", "disclosure", "merkleUpdate"]) {
    const href = await page.locator(`footer a:text-is("${label}"), .foot-col a:text-is("${label}")`).first().getAttribute("href").catch(() => null);
    assert(href && /\/blob\/main\/(docs|circuits)\//.test(href), `"${label}" -> ${href || "(missing)"} (expected a /blob/main/ deep-link)`);
  }
});

await tc("no console errors / failed requests on load + scroll", async () => {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  assert(errs.length === 0, errs.join(" | "));
});

await tc("primary CTA real-click lands in the working demo (prover Ready)", async () => {
  const cta = page.locator('a.btn-primary[href="/demo"]').first();
  assert(await cta.count() > 0, "no primary CTA to /demo");
  await cta.click();
  await page.waitForURL(/\/demo/, { timeout: 30000 });
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });
});

console.log(`\nUncaught page errors: ${errs.length ? JSON.stringify(errs) : "none"}`);
const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} landing checks passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
