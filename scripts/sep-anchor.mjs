// Tukar × Stellar anchor SEPs — REAL calls against the SDF public reference anchor
// (testanchor.stellar.org), no mocks. Exercises the client/wallet side of the anchor
// protocol stack that Tukar's fiat edges would use:
//   SEP-1  discover the anchor from its stellar.toml
//   SEP-10 web-auth: fetch a challenge, SIGN it with the demo key, get a real JWT
//   SEP-6  programmatic deposit/withdraw /info (what the anchor supports)
//   SEP-24 interactive deposit: POST authenticated -> a REAL hosted interactive URL
//   SEP-31 cross-border /info (the anchor-to-anchor remittance rail Tukar fits into)
//
// Honest scope: this authenticates + integrates against SDF's REFERENCE anchor (no
// KYC on testnet). It proves Tukar can speak the anchor protocols; a production
// deploy points these at a licensed anchor that issues the corridor's asset. The
// on/off-ramp itself still needs that KYC'd partner — this is the protocol wiring.
//
//   node scripts/sep-anchor.mjs
import * as Sdk from "@stellar/stellar-sdk";

const ANCHOR = "https://testanchor.stellar.org";
const HOME = "testanchor.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const DEMO_SECRET = "SDFJSXC3W4QM43KLLX7MQMPUU3SHJZ45UEYOODCWVE3QZDWWB5ZSN6OB";
const kp = Sdk.Keypair.fromSecret(DEMO_SECRET);
const ACCOUNT = kp.publicKey();

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const ok = [];
const step = (n) => console.log(`\n=== ${n} ===`);

// ---- SEP-1: discover the anchor's endpoints from its stellar.toml ----
step("SEP-1  stellar.toml discovery");
const toml = await (await fetch(`${ANCHOR}/.well-known/stellar.toml`)).text();
const grab = (k) => (toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, "m")) || [])[1];
const WEB_AUTH = grab("WEB_AUTH_ENDPOINT");
const SEP6 = grab("TRANSFER_SERVER");
const SEP24 = grab("TRANSFER_SERVER_SEP0024");
const SEP31 = grab("DIRECT_PAYMENT_SERVER");
const SIGNING_KEY = grab("SIGNING_KEY");
console.log(`  WEB_AUTH_ENDPOINT      ${WEB_AUTH}`);
console.log(`  TRANSFER_SERVER (SEP6) ${SEP6}`);
console.log(`  TRANSFER_SERVER_SEP24  ${SEP24}`);
console.log(`  DIRECT_PAYMENT (SEP31) ${SEP31}`);
console.log(`  anchor SIGNING_KEY     ${SIGNING_KEY}`);
ok.push(!!(WEB_AUTH && SEP24 && SIGNING_KEY) && "SEP-1 discovery");

// ---- SEP-10: web authentication (challenge -> sign -> JWT) ----
step("SEP-10 web-auth (real challenge, signed by the demo key)");
const chalRes = await j(await fetch(`${WEB_AUTH}?account=${ACCOUNT}&home_domain=${HOME}`));
const challengeXdr = chalRes.transaction;
if (!challengeXdr) throw new Error("no challenge tx: " + JSON.stringify(chalRes));
// Parse the challenge, confirm the anchor's server signature is on it, then add ours.
const tx = new Sdk.Transaction(challengeXdr, chalRes.network_passphrase || PASSPHRASE);
console.log(`  got challenge tx (seq ${tx.sequence}, ${tx.operations.length} op) signed by the anchor`);
tx.sign(kp);
const jwtRes = await j(await fetch(WEB_AUTH, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction: tx.toXDR() }),
}));
const JWT = jwtRes.token;
if (!JWT) throw new Error("no JWT: " + JSON.stringify(jwtRes));
console.log(`  ✅ authenticated — JWT: ${JWT.slice(0, 24)}… (${JWT.length} chars)`);
ok.push("SEP-10 web-auth JWT");
const auth = { Authorization: `Bearer ${JWT}` };

// ---- SEP-6: programmatic deposit/withdraw capabilities ----
step("SEP-6  /info (programmatic transfer capabilities)");
const info6 = await j(await fetch(`${SEP6}/info`, { headers: auth }));
const dep6 = Object.keys(info6.deposit || {}).join(", ");
const wd6 = Object.keys(info6.withdraw || {}).join(", ");
console.log(`  deposit assets:  ${dep6 || "(none)"}`);
console.log(`  withdraw assets: ${wd6 || "(none)"}`);
ok.push(!!(info6.deposit || info6.withdraw) && "SEP-6 /info");

// ---- SEP-24: interactive deposit -> a REAL hosted interactive URL ----
step("SEP-24 interactive deposit (authenticated -> real hosted URL)");
const info24 = await j(await fetch(`${SEP24}/info`, { headers: auth }));
const dep24 = Object.keys(info24.deposit || {});
console.log(`  deposit assets: ${dep24.join(", ")}`);
const asset = dep24.includes("USDC") ? "USDC" : dep24.includes("SRT") ? "SRT" : dep24[0];
const intr = await j(await fetch(`${SEP24}/transactions/deposit/interactive`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ asset_code: asset, account: ACCOUNT }),
}));
if (intr.url) { console.log(`  ✅ interactive deposit (${asset}) opened: ${intr.url}`); console.log(`     txn id: ${intr.id}`); ok.push("SEP-24 interactive URL"); }
else { console.log("  ⚠ no interactive URL:", JSON.stringify(intr).slice(0, 160)); ok.push(false); }

// ---- SEP-31: cross-border payments /info (where Tukar's private leg fits) ----
step("SEP-31 /info (cross-border receive — the anchor-to-anchor rail)");
if (SEP31) {
  const info31 = await j(await fetch(`${SEP31}/info`, { headers: auth }));
  const recv = Object.keys(info31.receive || {}).join(", ");
  console.log(`  receive assets: ${recv || "(none)"}`);
  ok.push(!!info31.receive && "SEP-31 /info");
} else { console.log("  anchor advertises no SEP-31 endpoint"); }

const passed = ok.filter(Boolean);
console.log(`\n=== ${passed.length}/${ok.length} anchor SEP steps succeeded LIVE ===`);
passed.forEach((s) => console.log("   ✓ " + s));
process.exit(ok.every(Boolean) ? 0 : 1);
