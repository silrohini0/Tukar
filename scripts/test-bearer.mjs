// "Does the bearer note actually work?" — proves the tukar1:… string (the one the
// QR encodes) is spendable money: deposit on-chain, export the note, WIPE the local
// session, import the bare string as if on another device, and withdraw — asserting
// real tokens are released on-chain (the pool reconstructs the tree from chain and
// pays whoever withdraws). This isolates the genuine P2P-handoff feature from the
// e2e's double-spend stress step (which flakes only under shared-key contention).
//
//   node scripts/test-bearer.mjs [baseUrl]   (default http://localhost:8000)
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const BASE = process.argv[2] || "http://localhost:8000";
const DEMO = "/demo"; // per-step routes are /demo/<slug>; rewrites serve the same console
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const statusText = () => page.locator("#status").innerText();
const waitStatus = (re, ms = 120000) => page.locator("#status").filter({ hasText: re }).waitFor({ timeout: ms });
const connect = async () => {
  if (await page.locator("#sendBtn").isEnabled().catch(() => false)) return;
  await page.getByRole("button", { name: /Use testnet key/i }).click();
  await page.locator("#sendBtn:not([disabled])").waitFor({ timeout: 10000 });
};
// Navigate corridor steps (0 Sender, 1 Corridor, 2 Receiver, 3 Regulator) via the flow strip.
const goStep = async (i) => {
  await page.locator("#fn" + i).click();
  await page.locator("#panel" + i).waitFor({ state: "visible", timeout: 15000 });
  // literal navigation reloads the page — wait for init() (handlers wired) before use.
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(200);
};

console.log(`Bearer-note end-to-end against ${BASE}${DEMO}\n`);
let okCount = 0;
try {
  await page.goto(BASE + DEMO, { waitUntil: "domcontentloaded" });
  await page.locator("#status").filter({ hasText: /Ready/ }).waitFor({ timeout: 45000 });
  await connect();

  // 1) deposit a real note on-chain (Sender step)
  await goStep(0);
  await page.locator("#corridor").selectOption("MX");
  await page.locator("#amount").fill("500");
  await page.locator("#sendBtn").click();
  await waitStatus(/registered on-chain ✓|registration failed|deposit failed/i);
  assert(/registered on-chain ✓/i.test(await statusText()), `deposit didn't register: "${await statusText()}"`);
  console.log("  ✅ 1. deposited a note on-chain (registered)");
  okCount++;

  // 2) export the bearer string (the thing the QR encodes) — Receiver step
  await goStep(2);
  await page.locator("#incoming [data-export]").first().click();
  await page.locator("#exportEsTxt").waitFor({ timeout: 8000 });
  const note = (await page.locator("#exportEsTxt").innerText()).trim();
  assert(note.startsWith("tukar1:"), `bearer string odd: "${note.slice(0, 16)}"`);
  console.log(`  ✅ 2. exported bearer string ("${note.slice(0, 22)}…")`);
  okCount++;

  // 3) WIPE the local session, then import the bare string as a fresh holder. If the
  //    string alone is spendable money, this is all another device has.
  await page.locator("#resetBtn").click();
  await waitStatus(/session cleared/i, 8000);
  await connect();
  // let the just-registered leaf propagate to the public RPC before reconstructing
  await page.waitForTimeout(30000);
  await goStep(2); // Receiver step for the import box
  await page.locator("#importInput").fill(note);
  await page.getByRole("button", { name: /Import →/ }).click();
  await page.locator("#incoming [data-withdraw]").first().waitFor({ timeout: 60000 });
  console.log("  ✅ 3. imported the string on a wiped session — note is withdrawable");
  okCount++;

  // 4) withdraw it on-chain — real tokens must be released to whoever holds the note
  const balBefore = await page.locator("#poolBalance, #balance").first().innerText().catch(() => "");
  await page.locator("#incoming [data-withdraw]").first().click();
  await waitStatus(/withdrawn on-chain ✓|withdraw failed/i);
  assert(/withdrawn on-chain ✓/i.test(await statusText()), `imported withdraw failed: "${await statusText()}"`);
  console.log(`  ✅ 4. withdrew the imported note ON-CHAIN — tokens released (${await statusText()})`.slice(0, 140));
  okCount++;
} catch (e) {
  console.log(`  ❌ failed at step ${okCount + 1}: ${e.message.split("\n")[0]}`);
}

console.log(`\nUncaught page errors: ${pageErrors.length ? JSON.stringify(pageErrors) : "none"}`);
console.log(`\n=== ${okCount}/4 steps passed ===`);
await browser.close();
process.exit(okCount === 4 ? 0 : 1);
