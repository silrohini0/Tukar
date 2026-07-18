// Focused UI test (Playwright, no on-chain) for the two receiver features:
//   1) a WITHDRAWN note is auto-hidden from the arrivals list;
//   2) an arrival can be OFF-RAMPED to a different corridor (its currency follows the
//      picker). Notes are injected into localStorage before load, so no deposit needed.
//
//   node scripts/test-offramp.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const POOL = "CD4CIE7IZSU5J7ZHVPQVEMYKO6CP7RTU3XT7TGUNUCOLKZGINVQZKFFS";
const STORE_KEY = `tukar:notes:${POOL}`;
const results = [];
const chk = (c, n) => { results.push([c, n]); console.log(`  ${c ? "✅" : "❌"} ${n}`); };

// One spendable Mexico note + one already-withdrawn note (must NOT show).
const session = {
  seq: 2, offramped: [],
  notes: [
    { id: 1, ref: "PAY-001", amount: "5000000000", corridor: "MX", spendable: true, commitment: "12345678901234567890", onchain: "ok" },
    { id: 2, ref: "PAY-000", amount: "1000000000", corridor: "MX", spendable: true, commitment: "98765432109876543210", onchain: "ok", withdrawn: "abc123", justWithdrawn: true },
  ],
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext();
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [STORE_KEY, JSON.stringify(session)]);
const page = await ctx.newPage();
page.setDefaultTimeout(30000);
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

console.log(`Receiver off-ramp/auto-hide test against ${BASE}/demo/receive\n`);
await page.goto(BASE + "/demo/receive", { waitUntil: "domcontentloaded" });
await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });
await page.waitForTimeout(500);

const arrivals = page.locator("#incoming .arrival");
chk((await arrivals.count()) === 1, `withdrawn note auto-hidden — 1 arrival shown, not 2 (got ${await arrivals.count()})`);
chk((await page.locator("#incoming").innerText()).includes("PAY-001"), "the spendable note (PAY-001) is shown");
chk(!(await page.locator("#incoming").innerText()).includes("PAY-000"), "the withdrawn note (PAY-000) is NOT shown");

chk(await page.locator("#incoming [data-offsel]").first().isVisible(), "off-ramp corridor picker present on the arrival");
chk((await page.locator("#rcvChip").innerText()).trim() === "MX", "receiver badge follows the note's corridor (MX)");

// Off-ramp the SAME note to the Philippines → currency/badge must follow.
await page.locator("#incoming [data-offsel]").first().selectOption("PH");
await page.waitForTimeout(400);
chk((await page.locator("#rcvChip").innerText()).trim() === "PH", "changing the picker → receiver badge becomes PH");
chk(/PHP/.test(await page.locator("#rcvRate").innerText()), "→ rate line now shows PHP");

// Reveal → the revealed local figure is in the chosen currency (PHP), not MXN.
// Check the revealed AMOUNT element specifically (the off-ramp <select> lists every
// corridor, incl. "Mexico · MXN", so the whole arrival's text always contains MXN).
await page.locator("#incoming [data-reveal]").first().click();
await page.locator("#incoming .mxn .amt").first().waitFor({ timeout: 10000 });
const amtTxt = await page.locator("#incoming .mxn .amt").first().innerText();
chk(/PHP/.test(amtTxt) && !/MXN/.test(amtTxt), `revealed amount is in PHP, not MXN — "${amtTxt.trim()}" (off-ramp to another corridor works)`);

chk(errs.length === 0, `no uncaught page errors${errs.length ? " (" + errs.join("; ") + ")" : ""}`);

const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} receiver checks passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
