// Records a silent demo walkthrough of Tukar into a .webm (add your own voiceover).
// landing → /demo → connect testnet key → Send (real on-chain deposit) → off-ramp
// (rate read on-chain from Reflector by the pool) → withdraw on-chain → disclosure
// (verified on-chain) → tamper (rejected on-chain).
//
// Usage: node scripts/record-demo.mjs [baseUrl] [outFile]
//   defaults: http://localhost:8000  (the latest local build)  +  tukar-demo.webm
// Note: drives the REAL embedded testnet key, so run it when that key is idle
// (no other test submitting at the same time) to avoid sequence contention.
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const OUT = process.argv[3] || "tukar-demo.webm";
// The local static server serves /demo.html; a hosted deploy would rewrite /demo. Match the e2e suite.
const DEMO = BASE.includes("localhost") ? "/demo.html" : "/demo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitStatus = async (p, re, tries = 70) => {
  for (let i = 0; i < tries; i++) {
    const s = await p.$eval("#status", (e) => e.textContent.trim()).catch(() => "");
    if (re.test(s)) return s;
    await sleep(1000);
  }
  return "";
};

const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--window-size=1280,720"] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

// Click a selector inside the page without throwing if it's absent (keeps a take
// going to a clean finalize even if one beat doesn't render).
const safeClick = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, sel).catch(() => {});
const setVal = (p, sel, v) => p.evaluate((s, val) => { const el = document.querySelector(s); if (el) el.value = val; }, sel, v).catch(() => {});

await p.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
const rec = await p.screencast({ path: OUT });
console.log("recording…", BASE, "->", OUT);

try {
  // 1) landing — hold on the hero, then glide down through the sections
  await sleep(2600);
  await p.evaluate(async () => {
    const end = document.body.scrollHeight - window.innerHeight;
    for (let y = 0; y <= end; y += 16) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 14)); }
  }).catch(() => {});
  await sleep(1200);

  // 2) into the live demo; wait for the prover to be ready
  await p.goto(BASE + DEMO, { waitUntil: "networkidle2", timeout: 60000 });
  await waitStatus(p, /Ready/, 30);
  await sleep(1500);

  // 3) connect the built-in testnet key (Send is gated on a real connection)
  await safeClick(p, "#demoKeyBtn");
  await sleep(1200);

  // 4) Send — real on-chain deposit into the Mexico corridor (default)
  await setVal(p, "#amount", "500");
  await sleep(900);
  await safeClick(p, "#sendBtn");
  console.log("deposit:", JSON.stringify(await waitStatus(p, /registered on-chain|registration failed|deposit failed/i)));
  await sleep(2600);

  // 5) Receiver — navigate to the Receiver step (per-page), then reveal & off-ramp
  //    (figure computed ON-CHAIN by the pool reading Reflector); linger on it
  await safeClick(p, "#fn2");
  await sleep(1200);
  await safeClick(p, "#incoming [data-reveal]");
  await sleep(3200);

  // 6) Withdraw the note on-chain (spend nullifier, release tokens)
  await safeClick(p, "#incoming [data-withdraw]");
  console.log("withdraw:", JSON.stringify(await waitStatus(p, /withdrawn on-chain|withdraw failed/i)));
  await sleep(2600);

  // 7) Regulator — navigate to the Regulator step, disclosure proof verified on-chain
  await safeClick(p, "#fn3");
  await sleep(1200);
  await p.select("#auditSelect", "1").catch(() => {});
  await sleep(700);
  await safeClick(p, "#proveBtn");
  for (let i = 0; i < 25; i++) {
    const t = await p.$eval("#result [data-onchain]", (e) => e.textContent).catch(() => "");
    if (/Verified on-chain/i.test(t)) break;
    await sleep(1000);
  }
  await sleep(3200);

  // 8) Tamper — a false amount is rejected in-browser and on-chain
  await p.evaluate(() => { const t = document.querySelector("#tamper"); if (t) t.checked = true; const b = document.querySelector("#proveBtn"); if (b) b.click(); }).catch(() => {});
  for (let i = 0; i < 25; i++) {
    const t = await p.$eval("#result [data-onchain]", (e) => e.textContent).catch(() => "");
    if (/rejected/i.test(t)) break;
    await sleep(1000);
  }
  await sleep(3500);
} catch (e) {
  console.log("flow warning:", e.message);
} finally {
  await rec.stop();        // always finalize the webm cleanly
  console.log("saved", OUT);
  await b.close();
}
