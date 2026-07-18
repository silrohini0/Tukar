// Native gasless proof — the no-gated-dependency alternative to Launchtube.
//
// Stellar's CAP-15 fee-bump transactions let one account (a "paymaster"/relayer)
// pay the network fee for a transaction *authorized and signed by another account*.
// That is exactly what a paymaster service like Launchtube provides (the user needs
// no XLM for fees) — except fee-bump is a NATIVE protocol feature, so it needs no
// gated API token and is verifiable on plain testnet.
//
// This script proves it end-to-end on testnet: a transaction signed by the public
// demo key has its entire fee paid by a fresh, independent paymaster account. We
// assert the paymaster's XLM dropped by the fee and the signer paid nothing.
//
// In Tukar this maps directly: a Freighter user (the signer) could deposit/withdraw
// with their fees sponsored by the app's relayer (the paymaster) — gasless UX, no
// Launchtube. The deposit/withdraw inner tx is a Soroban invoke; fee-bump wraps any
// inner transaction type identically (it's an envelope), so the mechanism shown here
// applies unchanged to the corridor's Soroban writes.
//
//   node scripts/feebump-paymaster.mjs
// Uses the browser @stellar/stellar-sdk over the system Chrome (same SDK the app
// loads) so it needs no extra node dependency. The demo key is the public throwaway
// testnet key; the paymaster is generated fresh and friendbot-funded each run.
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const DEMO_SECRET = "SDFJSXC3W4QM43KLLX7MQMPUU3SHJZ45UEYOODCWVE3QZDWWB5ZSN6OB"; // public throwaway testnet key

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(120000);
page.on("console", (m) => { if (m.type() === "error") console.log("PAGEERR:", m.text()); });
await page.goto("https://example.com", { waitUntil: "domcontentloaded" }); // any https origin for esm import

const out = await page.evaluate(async (DEMO_SECRET) => {
  const mod = await import("https://esm.sh/@stellar/stellar-sdk@14");
  const Sdk = mod.default ?? mod;
  const PP = "Test SDF Network ; September 2015";
  const horizon = new Sdk.Horizon.Server("https://horizon-testnet.stellar.org");
  const demo = Sdk.Keypair.fromSecret(DEMO_SECRET);
  const paymaster = Sdk.Keypair.random();
  await (await fetch("https://friendbot.stellar.org?addr=" + paymaster.publicKey())).json();
  const nativeBal = async (pk) => {
    const a = await (await fetch("https://horizon-testnet.stellar.org/accounts/" + pk)).json();
    return Number(a.balances.find((x) => x.asset_type === "native").balance);
  };
  const pBefore = await nativeBal(paymaster.publicKey());
  const dBefore = await nativeBal(demo.publicKey());
  // INNER: operations authorized + signed by the demo key (the "user"); nets 0 to it.
  const demoAcct = await horizon.loadAccount(demo.publicKey());
  const inner = new Sdk.TransactionBuilder(demoAcct, { fee: "100", networkPassphrase: PP })
    .addOperation(Sdk.Operation.payment({ destination: demo.publicKey(), asset: Sdk.Asset.native(), amount: "0.0000001" }))
    .setTimeout(120).build();
  inner.sign(demo);
  // FEE-BUMP: the paymaster pays the fee for the demo key's tx — gasless for the signer.
  const fb = Sdk.TransactionBuilder.buildFeeBumpTransaction(paymaster, "1000", inner, PP);
  fb.sign(paymaster);
  const res = await horizon.submitTransaction(fb);
  const pAfter = await nativeBal(paymaster.publicKey());
  const dAfter = await nativeBal(demo.publicKey());
  return {
    success: res.successful,
    hash: res.hash,
    feeChargedStroops: res.fee_charged,
    paymasterPaidXlm: +(pBefore - pAfter).toFixed(7),
    signerDeltaXlm: +(dAfter - dBefore).toFixed(7),
  };
}, DEMO_SECRET);

console.log(JSON.stringify(out, null, 2));
const ok = out.success && out.paymasterPaidXlm > 0 && out.signerDeltaXlm === 0;
console.log(ok
  ? "\n✅ GASLESS PROVEN: the paymaster paid the fee; the signer paid nothing (native fee-bump, no Launchtube)."
  : "\n❌ FAILED");
await browser.close();
process.exit(ok ? 0 : 1);
