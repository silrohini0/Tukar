// Per-page routing test (Playwright, no on-chain): the demo is now one corridor step
// per URL (/demo/send · /demo/corridor · /demo/receive · /demo/audit). Verifies that
// only the active step's panel shows, the flow strip + pager navigate (pushState),
// the browser Back button works (popstate), and a DIRECT load of a deep route renders
// the right panel (hosting/serve.mjs rewrites + boot-from-URL).
//
//   node scripts/test-pages.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/$/, "");
const results = [];
const chk = (c, n) => { results.push([c, n]); console.log(`  ${c ? "✅" : "❌"} ${n}`); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(45000);
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const vis = (sel) => page.locator(sel).isVisible();
const pathOf = () => new URL(page.url()).pathname;
const ready = () => page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });

console.log(`Per-page routing test against ${BASE}/demo\n`);

await page.goto(BASE + "/demo", { waitUntil: "domcontentloaded" });
// No flash-of-all-panels: even BEFORE init() finishes (prover still loading), only
// the Sender panel may be visible — panels are display:none by default in CSS and
// panel0 is .active in the HTML, so the first paint is already correct.
chk(await vis("#panel0") && !(await vis("#panel1")) && !(await vis("#panel2")) && !(await vis("#panel3")),
  "no flash-of-all-panels on load (only Sender visible pre-init)");
await ready();
chk(await vis("#panel0") && !(await vis("#panel1")) && !(await vis("#panel2")) && !(await vis("#panel3")),
  "load /demo → only the Sender panel is shown");

// Navigation is a LITERAL page change (full load), so wait for the real navigation.
await page.locator("#fn2").click();
await page.waitForURL(/\/demo\/receive$/, { timeout: 15000 }).catch(() => {});
await page.locator("#panel2").waitFor({ state: "visible", timeout: 15000 });
chk(/\/demo\/receive$/.test(pathOf()), "click the Receiver flow node → LITERALLY navigates to /demo/receive");
chk(await vis("#panel2") && !(await vis("#panel0")), "→ Receiver panel shown, Sender hidden");

await page.locator("#navPrev").click();
await page.waitForURL(/\/demo\/corridor$/, { timeout: 15000 }).catch(() => {});
await page.locator("#panel1").waitFor({ state: "visible", timeout: 15000 });
chk(/\/demo\/corridor$/.test(pathOf()), "pager Back → LITERALLY navigates to /demo/corridor");
chk(await vis("#panel1"), "→ Corridor panel shown");

await page.goBack();
await page.waitForURL(/\/demo\/receive$/, { timeout: 15000 }).catch(() => {});
chk(/\/demo\/receive$/.test(pathOf()), "browser Back button → /demo/receive");

await page.goto(BASE + "/demo/audit", { waitUntil: "domcontentloaded" });
await ready();
chk(await vis("#panel3") && !(await vis("#panel0")), "direct load /demo/audit → Regulator panel shown");

// demo-key connection persists across a FULL reload (localStorage rehydration) —
// connect on one step, hard-navigate to another, and it should still be connected.
await page.goto(BASE + "/demo/send", { waitUntil: "domcontentloaded" });
await ready();
await page.getByRole("button", { name: /Use testnet key/i }).click();
await page.locator("#sendBtn:not([disabled])").waitFor({ timeout: 10000 });
await page.goto(BASE + "/demo/receive", { waitUntil: "domcontentloaded" });
await ready();
await page.waitForTimeout(1500); // allow init to rehydrate the connection
chk(/testnet key/i.test(await page.locator("#walletTag").innerText().catch(() => "")),
  "demo-key connection persists across a full reload (localStorage rehydration)");

chk(errs.length === 0, `no uncaught page errors${errs.length ? " (" + errs.join("; ") + ")" : ""}`);

const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} routing checks passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
