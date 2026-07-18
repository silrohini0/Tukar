// End-to-end test driving REAL user interactions (genuine clicks/typing/selects,
// not evaluate-injection) with Playwright over the system Chrome. The demo is now
// ONE corridor step per URL (/demo/send · /demo/corridor · /demo/receive ·
// /demo/audit), so each case navigates to the relevant step (via the flow strip)
// before interacting. Covers UI gating, input validation, corridor switching, the
// payment-request round-trip, and the full on-chain flows: deposit→reveal→withdraw→
// disclose→tamper, compliance-forge rejection, bearer-note P2P handoff, double-spend.
//
//   node scripts/e2e-playwright.mjs [baseUrl]   (default http://localhost:8000)
// Run with the embedded demo key IDLE (no concurrent submitter) for the on-chain
// cases — back-to-back runs collide on the shared key's sequence (txBadSeq).
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const results = [];
const ok = (name) => { results.push([true, name]); console.log(`  ✅ ${name}`); };
const bad = (name, why) => { results.push([false, `${name} — ${why}`]); console.log(`  ❌ ${name} — ${why}`); };
async function tc(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message.split("\n")[0]); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const settleKey = () => new Promise((r) => setTimeout(r, 30000));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept().catch(() => {}));

const DEMO = "/demo"; // SPA root; per-step routes are /demo/<slug> (rewrites serve the same console)
const statusText = () => page.locator("#status").innerText();
const waitStatus = (re, ms = 120000) => page.locator("#status").filter({ hasText: re }).waitFor({ timeout: ms });
// Navigate to a corridor step (0 Sender, 1 Corridor, 2 Receiver, 3 Regulator) via the
// always-visible flow strip — client-side nav, so in-memory state (notes, connection)
// is preserved and the target panel becomes interactable.
const goStep = async (i) => {
  await page.locator("#fn" + i).click();
  await page.locator("#panel" + i).waitFor({ state: "visible", timeout: 15000 });
  // literal navigation reloads the page — wait for init() to finish (handlers wired,
  // prover ready) before interacting, else clicks land on an un-wired page.
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(200);
};
const connect = async () => {
  if (await page.locator("#sendBtn").isEnabled().catch(() => false)) return; // already connected
  await page.getByRole("button", { name: /Use testnet key/i }).click();
  await page.locator("#sendBtn:not([disabled])").waitFor({ timeout: 10000 });
};

console.log(`E2E (Playwright real-click, per-page) against ${BASE}${DEMO}\n`);
await page.goto(BASE + DEMO, { waitUntil: "domcontentloaded" });

// 1) prover initializes
await tc("prover loads to Ready", async () => {
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });
});

// 2) Send gated before connecting (Sender step)
await tc("Send disabled before connecting", async () => {
  assert(await page.locator("#sendBtn").isDisabled(), "#sendBtn should be disabled pre-connect");
});

// 3) payment request round-trip (receiver requests -> sender loads) — UI only, spans 2 steps
await tc("payment request round-trip (reverse direction)", async () => {
  await goStep(2); // Receiver
  await page.locator("#reqAmount").fill("750");
  await page.getByRole("button", { name: /Request →/ }).click();
  await page.locator("#reqEsTxt").waitFor({ timeout: 5000 });
  const reqStr = (await page.locator("#reqEsTxt").innerText()).trim();
  assert(reqStr.startsWith("tukreq1:"), `request string odd: "${reqStr.slice(0, 20)}"`);
  await goStep(0); // Sender
  await page.locator("#reqLoadInput").fill(reqStr);
  await page.getByRole("button", { name: /Load →/ }).click();
  await waitStatus(/Loaded a request for 750/i, 8000);
  assert((await page.locator("#amount").inputValue()) === "750", "amount not populated from request");
});

// 4) connecting enables Send (real click)
await tc("Use testnet key enables Send", async () => { await goStep(0); await connect(); });

// 5) invalid amounts never crash and never start a send (Sender step)
await tc("invalid amounts rejected, no crash", async () => {
  await goStep(0);
  const before = pageErrors.length;
  for (const v of ["0", "-5", "1e308", "99999999999", ""]) {
    await page.locator("#amount").fill(v);
    await page.locator("#sendBtn").click();
    await page.waitForTimeout(450);
    assert(!/building|depositing|registering/i.test(await statusText()), `amount "${v}" started a send`);
  }
  assert(pageErrors.length === before, `uncaught: ${pageErrors.slice(before).join("; ")}`);
});

// 5b) junk typed into Load (Sender) / Import (Receiver) is handled gracefully (no
// crash). Each part starts from a CLEAN direct load of its step page — the faithful
// "user lands here and mistypes" case, and it avoids any cross-case timing race.
await tc("junk in Load/Import handled gracefully (no crash)", async () => {
  const before = pageErrors.length;
  await page.goto(BASE + "/demo/send", { waitUntil: "domcontentloaded" });
  await page.locator("#reqLoadInput").waitFor({ state: "visible", timeout: 45000 });
  await page.locator("#reqLoadInput").fill("ya");
  await page.getByRole("button", { name: /Load →/ }).click();
  await page.waitForTimeout(400);
  assert(/Couldn.t load that request/i.test(await statusText()), `Load junk gave: "${await statusText()}"`);
  assert((await page.locator("#amount").inputValue()) !== "ya", "amount polluted by junk Load");
  await page.goto(BASE + "/demo/receive", { waitUntil: "domcontentloaded" });
  await page.locator("#importInput").waitFor({ state: "visible", timeout: 45000 });
  await page.locator("#importInput").fill("ya");
  await page.getByRole("button", { name: /Import →/ }).click();
  await page.waitForTimeout(400);
  assert(/Couldn.t import that note/i.test(await statusText()), `Import junk gave: "${await statusText()}"`);
  assert(pageErrors.length === before, `uncaught: ${pageErrors.slice(before).join("; ")}`);
});

// 6) all 7 corridors switch; MXN/BRL/ARS read on-chain, others on FX-API fallback (Sender step)
await tc("corridor switching + labels (3 on-chain, 4 fallback)", async () => {
  await goStep(0);
  await page.waitForTimeout(4000);
  const want = { MX: /Reflector oracle \(on-chain\)/, BR: /Reflector oracle \(on-chain\)/, AR: /Reflector oracle \(on-chain\)/, PH: /· live/, IN: /· live/, NG: /· live/, CO: /· live/ };
  for (const [code, re] of Object.entries(want)) {
    await page.locator("#corridor").selectOption(code);
    await page.waitForTimeout(150);
    const txt = await page.locator("#rcvRate").innerText();
    assert(re.test(txt), `${code} label "${txt}" !~ ${re}`);
  }
});

// 7) full on-chain happy path (Sender -> auto-advance to Corridor -> Receiver -> Regulator)
await tc("FULL flow: deposit→reveal→withdraw→disclose→tamper", async () => {
  await goStep(0);
  await connect(); // re-assert connection (case 5b reloaded the page)
  await page.locator("#corridor").selectOption("MX");
  await page.locator("#amount").fill("500");
  await page.locator("#sendBtn").click();
  await waitStatus(/registered on-chain ✓|registration failed|deposit failed/i);
  assert(/registered on-chain ✓/i.test(await statusText()), `deposit didn't register: "${await statusText()}"`);
  await goStep(2); // Receiver
  await page.locator("#incoming [data-reveal]").first().click();
  await page.locator("#incoming .mxn .amt").first().waitFor({ timeout: 15000 });
  assert(/MXN/.test(await page.locator("#incoming .mxn .amt").first().innerText()), "off-ramp reveal odd");
  await page.locator("#incoming [data-withdraw]").first().click();
  await waitStatus(/withdrawn on-chain ✓|withdraw failed/i);
  assert(/withdrawn on-chain ✓/i.test(await statusText()), `withdraw failed: "${await statusText()}"`);
  await goStep(3); // Regulator
  await page.locator("#auditSelect").selectOption("1").catch(() => {});
  await page.locator("#proveBtn").click();
  await page.locator("#result [data-onchain]").filter({ hasText: /Verified on-chain/i }).waitFor({ timeout: 40000 });
  await page.locator("#tamperLabel").click();
  await page.locator("#proveBtn").click();
  await page.locator("#result [data-onchain]").filter({ hasText: /rejected/i }).waitFor({ timeout: 40000 });
});

// 8) compliance forge: a forged-source deposit is REJECTED on-chain by the ASP (Sender step)
await settleKey();
await tc("compliance forge → deposit rejected on-chain by ASP", async () => {
  await goStep(0);
  await page.locator("#amount").fill("300");
  await page.locator("#compTamperLabel").click(); // forge the source
  await page.locator("#sendBtn").click();
  await waitStatus(/REJECTED by the ASP|rejected|failed/i, 120000);
  assert(/REJECTED by the ASP/i.test(await statusText()), `expected ASP rejection, got: "${await statusText()}"`);
  // The forge toggle must AUTO-CLEAR on rejection so a real send isn't trapped re-forging.
  assert(!(await page.locator("#compTamper").isChecked()), "forge toggle should auto-clear after the ASP rejection");
});

// 9) bearer-note P2P handoff + double-spend rejection (Sender deposit -> Receiver handoff)
await settleKey();
await tc("bearer note: export→reset→import→withdraw, then double-spend rejected", async () => {
  await goStep(0);
  await page.locator("#amount").fill("400");
  await page.locator("#sendBtn").click();
  await waitStatus(/registered on-chain ✓|registration failed|deposit failed/i);
  assert(/registered on-chain ✓/i.test(await statusText()), "bearer deposit didn't register");
  await settleKey(); // let the leaf propagate before reset+reconstruct
  await goStep(2); // Receiver
  await page.locator("#incoming [data-export]").first().click();
  await page.locator("#exportEsTxt").waitFor({ timeout: 8000 });
  const note = (await page.locator("#exportEsTxt").innerText()).trim();
  assert(note.startsWith("tukar1:"), `bearer string odd: "${note.slice(0, 16)}"`);
  await page.locator("#resetBtn").click(); // resets to Sender step
  await waitStatus(/session cleared/i, 8000);
  await goStep(0); await connect();
  await goStep(2);
  await page.locator("#importInput").fill(note);
  await page.getByRole("button", { name: /Import →/ }).click();
  await page.locator("#incoming [data-withdraw]").first().waitFor({ timeout: 60000 });
  await page.locator("#incoming [data-withdraw]").first().click();
  await waitStatus(/withdrawn on-chain ✓|withdraw failed/i);
  assert(/withdrawn on-chain ✓/i.test(await statusText()), `imported withdraw failed: "${await statusText()}"`);
  // Double-spend = a SECOND holder of the same bearer string (a different device).
  // Re-importing into THIS wallet is (correctly) refused as a duplicate, so simulate
  // the other holder by clearing the session first, then re-import and try to withdraw
  // the already-spent note — the on-chain nullifier rejects it (#2).
  await settleKey();
  await page.locator("#resetBtn").click();
  await waitStatus(/session cleared/i, 8000);
  await goStep(0); await connect();
  await goStep(2);
  await page.locator("#importInput").fill(note);
  await page.getByRole("button", { name: /Import →/ }).click();
  await page.locator("#incoming [data-withdraw]").first().waitFor({ timeout: 60000 });
  await page.locator("#incoming [data-withdraw]").first().click();
  await waitStatus(/already spent|nullifier|withdraw failed/i, 120000);
  assert(/already spent|nullifier/i.test(await statusText()), `double-spend not caught: "${await statusText()}"`);
});

// 10) disconnect re-gates Send (Sender step)
await tc("disconnect re-gates Send", async () => {
  await goStep(0);
  await connect(); // establish the connected state first (a literal reload may have reset it)
  await page.getByRole("button", { name: /^Disconnect$/i }).first().click();
  await page.locator("#sendBtn[disabled]").waitFor({ timeout: 8000 });
});

console.log(`\nUncaught page errors during run: ${pageErrors.length ? JSON.stringify(pageErrors) : "none"}`);
const passed = results.filter((r) => r[0]).length;
console.log(`\n=== ${passed}/${results.length} cases passed ===`);
results.filter((r) => !r[0]).forEach((r) => console.log("FAIL:", r[1]));
await browser.close();
process.exit(passed === results.length ? 0 : 1);
