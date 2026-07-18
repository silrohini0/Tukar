// "Scan the barcode" — proves the QR codes Tukar renders actually decode back to
// the exact bearer-note / payment-request string a phone camera would read. Loads
// the live demo, generates each QR, then decodes the rendered PNG with jsQR IN the
// browser (same pixels a scanner sees) and asserts decoded === the visible string.
// The QR uses custom colors (dark #0a0705 on #f3ad79); this confirms a real scanner
// still reads them.
//
//   node scripts/scan-qr.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const DEMO = "/demo"; // per-step routes are /demo/<slug>; rewrites serve the same console
const results = [];
const ok = (n) => { results.push([true, n]); console.log(`  ✅ ${n}`); };
const bad = (n, w) => { results.push([false, `${n} — ${w}`]); console.log(`  ❌ ${n} — ${w}`); };

// Decode the QR <img> in slotSel the way a camera would: draw its pixels to a
// canvas and run jsQR over them. Returns the decoded text (or null).
const scan = (page, slotSel) => page.evaluate(async (sel) => {
  const img = document.querySelector(sel + " img");
  if (!img) return { decoded: null, err: "no <img> in " + sel };
  const jsQR = (await import("https://esm.sh/jsqr@1.4.0")).default;
  const im = new Image();
  im.crossOrigin = "anonymous";
  await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error("img load")); im.src = img.src; });
  const c = document.createElement("canvas");
  c.width = im.naturalWidth || 168; c.height = im.naturalHeight || 168;
  const ctx = c.getContext("2d");
  ctx.drawImage(im, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const code = jsQR(d.data, c.width, c.height);
  return { decoded: code ? code.data : null, w: c.width, h: c.height };
}, slotSel);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// Navigate corridor steps (0 Sender, 1 Corridor, 2 Receiver, 3 Regulator) via the flow strip.
const goStep = async (i) => {
  await page.locator("#fn" + i).click();
  await page.locator("#panel" + i).waitFor({ state: "visible", timeout: 15000 });
  // literal navigation reloads the page — wait for init() (handlers wired) before use.
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(200);
};

console.log(`QR scan test against ${BASE}${DEMO}\n`);
await page.goto(BASE + DEMO, { waitUntil: "domcontentloaded" });
await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });

// 1) Payment-request QR (no chain needed) — Request 500 on the Receiver step, scan #reqQr.
try {
  await goStep(2);
  await page.locator("#reqAmount").fill("500");
  await page.getByRole("button", { name: /Request →/ }).click();
  await page.locator("#reqEsTxt").waitFor({ timeout: 8000 });
  const want = (await page.locator("#reqEsTxt").innerText()).trim();
  await page.locator("#reqQr img").waitFor({ timeout: 8000 });
  const got = await scan(page, "#reqQr");
  if (!got.decoded) bad("payment-request QR decodes", `jsQR returned null (${got.err || got.w + "x" + got.h})`);
  else if (got.decoded !== want) bad("payment-request QR decodes", `decoded != shown\n     got:  ${got.decoded.slice(0, 48)}…\n     want: ${want.slice(0, 48)}…`);
  else { ok(`payment-request QR decodes to the exact tukreq1 string (${got.w}x${got.h}px)`); console.log(`     "${got.decoded.slice(0, 40)}…"`); }
} catch (e) { bad("payment-request QR decodes", e.message.split("\n")[0]); }

// 2) Bearer-note QR (the "money") — connect, deposit on-chain, export, scan #exportQr.
try {
  await goStep(0); // Sender
  if (!(await page.locator("#sendBtn").isEnabled().catch(() => false))) {
    await page.getByRole("button", { name: /Use testnet key/i }).click();
    await page.locator("#sendBtn:not([disabled])").waitFor({ timeout: 10000 });
  }
  await page.locator("#amount").fill("500");
  await page.locator("#sendBtn").click();
  await page.locator("#status").filter({ hasText: /registered on-chain ✓|registration failed|deposit failed/i }).waitFor({ timeout: 120000 });
  const st = (await page.locator("#status").innerText()).trim();
  if (!/registered on-chain ✓/i.test(st)) throw new Error("deposit didn't register: " + st);
  await goStep(2); // Receiver
  await page.locator("#incoming [data-export]").first().click();
  await page.locator("#exportEsTxt").waitFor({ timeout: 8000 });
  const want = (await page.locator("#exportEsTxt").innerText()).trim();
  await page.locator("#exportQr img").waitFor({ timeout: 8000 });
  const got = await scan(page, "#exportQr");
  if (!got.decoded) bad("bearer-note QR decodes", `jsQR returned null (${got.err || got.w + "x" + got.h})`);
  else if (got.decoded !== want) bad("bearer-note QR decodes", `decoded != shown`);
  else { ok(`bearer-note QR decodes to the exact tukar1 string (${got.w}x${got.h}px)`); console.log(`     "${got.decoded.slice(0, 40)}…"`); }
} catch (e) { bad("bearer-note QR decodes", e.message.split("\n")[0]); }

console.log(`\nUncaught page errors: ${pageErrors.length ? JSON.stringify(pageErrors) : "none"}`);
const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} QR scans passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
