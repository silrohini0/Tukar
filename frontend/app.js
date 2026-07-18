// Tukar — Corridor Console. Real ZK proving (snarkjs) in the browser, mirrored
// by the live BN254 Groth16 verifiers on Stellar testnet. UI from the hifi
// design handoff; all crypto/contract calls are real (see stellar.js).
import * as snarkjs from "https://esm.sh/snarkjs@0.7.5";
import { buildPoseidon } from "https://esm.sh/circomlibjs@0.1.7";
import { verifyDisclosureOnChain, readPoolState, readRecentActivity, loadLeavesFromChain, readCurrentRoot, depositOnChain, registerRootOnChain, withdrawSubmit, extDataHashFor, activeAddress, explorer, txExplorer, readReflectorFx, offrampQuote, offrampQuoteTwap, anchorOnramp, POOL, DISCLOSURE_VERIFIER } from "./stellar.js";
import { connect as walletConnect, disconnect as walletDisconnect, setupTestnetFunds } from "./wallet.js";
import { makeTree } from "./tree.js";

const VERIFIER_CONTRACT = DISCLOSURE_VERIFIER;
const VERIFIER_URL = `https://lab.stellar.org/r/testnet/contract/${VERIFIER_CONTRACT}`;
const WASM = "./circuit/disclosure.wasm";
const ZKEY = "./circuit/disclosure_final.zkey";
const VKEY = "./circuit/verification_key.json";
// BN254 scalar field modulus
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const STROOPS = 10_000_000n; // USDC has 7 decimals on Stellar

// Off-ramp corridors (Country B). `rate` is a sensible static fallback; it's
// refreshed with LIVE USD->local FX on load so the figure revealed at the edge is
// a real exchange rate, not a hardcoded number. `oracle` names the symbol carried
// by Reflector's on-chain SEP-40 FX feed (testnet) — those corridors read their
// rate from the Stellar ledger itself; the rest fall back to a public FX API.
const CORRIDORS = [
  { code: "MX", country: "Mexico",      recipient: "María · Mexico City",  currency: "MXN", symbol: "$",  rate: 17.1, oracle: "MXN" },
  { code: "BR", country: "Brazil",      recipient: "João · São Paulo",     currency: "BRL", symbol: "R$", rate: 5.2,  oracle: "BRL" },
  { code: "AR", country: "Argentina",   recipient: "Sofía · Buenos Aires", currency: "ARS", symbol: "$",  rate: 1450, oracle: "ARS" },
  { code: "PH", country: "Philippines", recipient: "Andrea · Manila",      currency: "PHP", symbol: "₱",  rate: 58.5 },
  { code: "IN", country: "India",       recipient: "Rohan · Mumbai",       currency: "INR", symbol: "₹",  rate: 83.4 },
  { code: "NG", country: "Nigeria",     recipient: "Chidi · Lagos",        currency: "NGN", symbol: "₦",  rate: 1570 },
  { code: "CO", country: "Colombia",    recipient: "Camila · Bogotá",      currency: "COP", symbol: "$",  rate: 3950 },
];
let fxLive = false; // true once live FX rates have been applied
const corridorByCode = (code) => CORRIDORS.find((c) => c.code === code) || CORRIDORS[0];
const selectedCorridor = () => corridorByCode($("corridor") ? $("corridor").value : "MX");
// The RECEIVER side (badge + rate) follows the most-recent arrival's corridor — a note
// is bound to the corridor it was SENT to, so its off-ramp currency is fixed. This
// stops the receiver panel from showing e.g. "PH / PHP" while an existing Mexico note
// reveals MXN (the mismatch a user hit switching the sender dropdown after a payment).
// Falls back to the sender's selected corridor as a preview when nothing has arrived.
const receiverCorridor = () => {
  const arr = notes.find((n) => n.spendable && (!n.withdrawn || n.justWithdrawn));
  return arr ? corridorByCode(arr.offCorridor || arr.corridor) : selectedCorridor();
};
const fmtRate = (r) => (r >= 100 ? Math.round(r).toLocaleString("en-US") : r.toFixed(2));

const $ = (id) => document.getElementById(id);
const status = $("status");
// Escape user-controlled strings before they go into innerHTML. Imported bearer
// notes / payment requests carry attacker-chosen fields (ref, memo); without this
// a crafted note could inject script and exfiltrate the localStorage keys.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isFieldStr = (s) => typeof s === "string" && /^\d{1,78}$/.test(s);
let poseidon, F, vkey, tree;
let notes = [];
let leaves = []; // BigInt commitments registered on-chain, in tree order
let seq = 0;
let proofState = "idle";

// Persist this browser's notes (secrets) so a reload can still withdraw: the tree
// is reconstructed from on-chain state, and the note keys restore from here.
// Keyed by pool so notes from a previous pool deployment don't leak in. (Demo
// throwaway keys only — never persist real spending keys to localStorage.)
const STORE_KEY = `tukar:notes:${POOL}`;
function saveSession() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      seq,
      offramped: [...offramped],
      notes: notes.map((n) => ({ ...n, withdrawing: false })),
    }));
  } catch (_) { /* storage unavailable — session stays in-memory */ }
}
function loadSession() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!d) return;
    // withdrawing/justWithdrawn are transient UI flags — reset on load so a withdrawn
    // note stays hidden (never reappears) and no "spinning" state survives a reload.
    if (Array.isArray(d.notes)) notes = d.notes.map((n) => ({ ...n, withdrawing: false, justWithdrawn: false }));
    if (Array.isArray(d.offramped)) d.offramped.forEach((id) => offramped.add(id));
    if (typeof d.seq === "number") seq = d.seq;
  } catch (_) { /* corrupt store — ignore */ }
}

$("verifierLink").href = VERIFIER_URL;

// ---- inline SVG icon set (matches the design's icon() paths) ----
const ICON = {
  reset: ["M20 11A8 8 0 0 0 6 6L4 8", "M4 4V8H8", "M4 13A8 8 0 0 0 18 18L20 16", "M20 20V16H16"],
  shield: ["M12 3 19 6V11C19 16 16 19 12 21 8 19 5 16 5 11V6Z", "M9.4 11.6 12 9 14.6 11.6 12 14.2Z"],
  lock: ["M6 11H18V20H6Z", "M8.5 11V8A3.5 3.5 0 0 1 15.5 8V11"],
  diamond: ["M12 4 20 12 12 20 4 12Z"],
  sealCheck: ["M12 3 20 8 18 17 12 21 6 17 4 8Z", "M8.5 12 11 14.5 15.5 9"],
  sealX: ["M12 3 20 8 18 17 12 21 6 17 4 8Z", "M9.5 9.5 14.5 14.5", "M14.5 9.5 9.5 14.5"],
  spark: ["M12 4 13.6 10.4 20 12 13.6 13.6 12 20 10.4 13.6 4 12 10.4 10.4Z"],
  offramp: ["M4 20H20", "M12 4V9.5", "M9 12 12 9 15 12 12 15Z", "M12 15V19.5", "M9.6 17.6 12 20 14.4 17.6"],
  link: ["M9.5 14.5 14.5 9.5", "M11 7.5 12.5 6A3.5 3.5 0 0 1 18 11L16.5 12.5", "M13 16.5 11.5 18A3.5 3.5 0 0 1 6 13L7.5 11.5"],
};
function icon(name, size, stroke) {
  const d = (ICON[name] || ICON.diamond).map((p) => `<path d="${p}"/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function randomFieldElement() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x % R;
}

// Deterministically map an audit-context string to a field element.
function contextToField(str) {
  const bytes = new TextEncoder().encode(str);
  let x = 0n;
  for (const b of bytes) x = (x * 257n + BigInt(b)) % R;
  return x;
}

function usdcToStroops(usdc) {
  const [whole, frac = ""] = String(usdc).split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * STROOPS + BigInt(fracPadded || "0");
}

function fmtUsdc(stroops) {
  const s = BigInt(stroops);
  const whole = s / STROOPS;
  const frac = (s % STROOPS).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const short = (s) => `${String(s).slice(0, 10)}…${String(s).slice(-8)}`;
const shortHash = (s) => `0x${BigInt(s).toString(16).slice(0, 8)}…${BigInt(s).toString(16).slice(-2)}`;

// Light the active panel + flow node for the current step (0..3).
// ---- Per-step routing: each corridor stage is its own URL (/demo/<slug>). Panel
// index == step index (0 Sender, 1 Corridor, 2 Receiver, 3 Regulator). Only the
// active step's panel is shown; navigation pushes a real URL so a direct load /
// refresh / shared link of any step works (a hosting rewrite maps /demo/* -> /demo.html,
// same as serve.mjs locally, and state is rehydrated from localStorage on boot). ----
const STEPS = [
  { slug: "send", label: "Sender" },
  { slug: "corridor", label: "Corridor" },
  { slug: "receive", label: "Receiver" },
  { slug: "audit", label: "Regulator" },
];
function stepIndexFromPath() {
  const m = location.pathname.match(/\/demo\/(send|corridor|receive|audit)\/?$/);
  const i = m ? STEPS.findIndex((s) => s.slug === m[1]) : 0;
  return i < 0 ? 0 : i;
}
function showStep(n, push) {
  n = Math.max(0, Math.min(STEPS.length - 1, n));
  // Panel visibility is driven by html[data-step] in CSS (also set by an inline
  // head script before first paint, so any route — incl. literal step-page loads —
  // shows the correct single panel with no flash). Here we just keep it in sync.
  document.documentElement.setAttribute("data-step", String(n));
  for (let i = 0; i < 4; i++) {
    const on = i === n;
    const p = $("panel" + i);
    if (p) p.classList.toggle("active", on);
    const f = $("fn" + i);
    if (f) f.classList.toggle("active", on);
  }
  const prev = $("navPrev"), next = $("navNext"), lab = $("navLabel");
  // display (not visibility) so a hidden Back/Next leaves NO gap — keeps the pager a
  // tight centered group instead of flinging Next to the far edge on the first step.
  if (prev) prev.style.display = n > 0 ? "" : "none";
  if (next) next.style.display = n < STEPS.length - 1 ? "" : "none";
  if (lab) lab.textContent = `Step ${n + 1} of ${STEPS.length} · ${STEPS[n].label}`;
  const want = "/demo/" + STEPS[n].slug;
  if (push && location.pathname !== want) history.pushState({ step: n }, "", want);
  window.scrollTo(0, 0);
}
// setActiveStep is the navigation primitive: existing flow code that advances the
// step (after a deposit, import, withdraw, …) now navigates to that step's page.
function setActiveStep(n) { showStep(n, true); }
window.addEventListener("popstate", () => showStep(stepIndexFromPath(), false));

// Rebuild the Merkle tree from on-chain events, but ONLY trust it if its root
// matches the pool's live current_root. If the RPC event window doesn't reach far
// enough back (incomplete reconstruction), return null and the caller keeps the
// session-local tree — so this is a strict improvement with no regression.
async function syncedLeaves() {
  try {
    const ls = await loadLeavesFromChain();         // BigInt[] in tree order
    const recon = tree.root(ls);                    // == genesis when empty
    const onchain = await readCurrentRoot();
    if (onchain != null && recon === onchain) return ls; // verified (incl. empty==genesis)
    console.warn(`[tukar] tree reconstruction unverified (${ls.length} leaves) — session-local`);
  } catch (e) { console.warn("[tukar] tree sync failed:", e && e.message); }
  return null;
}

const BUILD = "v6-accumulator";
// Fill the corridor dropdown + reflect the selected corridor on the receiver side.
function populateCorridors() {
  const sel = $("corridor");
  if (!sel) return;
  sel.innerHTML = CORRIDORS.map((c) => `<option value="${c.code}">${c.country} · ${c.currency}</option>`).join("");
  sel.value = "MX";
}
function updateCorridorUI() {
  const c = receiverCorridor(); // receiver badge/rate reflect what's being received
  if ($("rcvChip")) $("rcvChip").textContent = c.code;
  const src = c.source === "reflector" ? " · via Reflector oracle (on-chain)"
            : c.source === "fx-api" ? " · live"
            : "";
  if ($("rcvRate")) $("rcvRate").textContent = `USDC → ${c.currency} at the edge · rate ${fmtRate(c.rate)}${src}`;
}
// Real USD->local FX (no API key, no mock). Two sources, in order of preference:
//  1) Reflector's on-chain SEP-40 oracle for the corridors its testnet feed carries
//     (read straight from the Stellar ledger — see readReflectorFx in stellar.js);
//  2) a public FX API for the rest. Either failing just keeps the static fallback,
//     so the off-ramp figure is always sensible.
async function loadFxRates() {
  // 1) On-chain Reflector oracle (real Stellar read) for corridors it supports.
  await Promise.all(CORRIDORS.filter((c) => c.oracle).map(async (c) => {
    const fx = await readReflectorFx(c.oracle);
    if (fx && fx.rate > 0) {
      c.rate = fx.rate; c.source = "reflector"; fxLive = true;
      console.log(`[tukar] FX ${c.currency} via Reflector oracle: ${fmtRate(fx.rate)} (on-chain)`);
    }
  }));
  // 2) Public FX API fallback for everything Reflector didn't fill.
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    const rates = j && j.rates;
    if (rates) {
      for (const c of CORRIDORS) {
        if (c.source === "reflector") continue;
        const v = rates[c.currency];
        if (typeof v === "number" && v > 0) { c.rate = v; c.source = "fx-api"; fxLive = true; }
      }
    }
  } catch (_) { /* keep static fallbacks */ }
  updateCorridorUI();
  renderReceiver();
}

async function init() {
  populateCorridors();
  updateCorridorUI();
  loadFxRates(); // async, non-blocking
  try {
    // Load ONLY what's needed to be interactive: Poseidon + vkey (both local/cached).
    // The on-chain tree sync (an RPC read, the slow + variable part) is DEFERRED to the
    // background so "Ready" shows fast on every literal page load — deposit/withdraw
    // re-sync the tree from chain before they act anyway, so nothing is lost.
    console.log(`[tukar ${BUILD}] loading prover (Poseidon + vkey)…`);
    status.textContent = "Loading zero-knowledge prover…";
    const [pos] = await Promise.all([
      buildPoseidon(),
      (async () => { vkey = await (await fetch(VKEY)).json(); })(),
    ]);
    poseidon = pos;
    F = poseidon.F;
    tree = makeTree(F, poseidon);
    loadSession(); // restore this browser's notes so withdraw survives a reload
    // Rehydrate the demo-key connection across page navigations / refresh (only the
    // built-in testnet key — a Freighter connection needs an explicit re-approval).
    if (localStorage.getItem("tukar:conn") === "demo") {
      walletDisconnect(); walletConn = null;
      showConnected(`<b>testnet key</b> · ${shortAddr(activeAddress())}`, null);
    }
    status.textContent = notes.length
      ? `Ready · ${notes.length} saved payment(s) restored.`
      : "Ready · zero-knowledge prover loaded.";
    showStep(stepIndexFromPath(), false); // open the step the URL asks for
    render();
    // Background: mirror the on-chain tree + pool state without blocking readiness.
    (async () => {
      const synced = await syncedLeaves();
      if (synced) { leaves = synced; render(); }
      console.log(`[tukar ${BUILD}] tree synced in background — ${synced ? synced.length + " leaves" : "session-local"}`);
      loadPoolState();
    })();
  } catch (e) {
    console.error("[tukar] init failed:", e);
    status.textContent = "Init error: " + ((e && e.message) || e) + " — open the console (F12) for details.";
  }
}

// Read the pool's live commitment count from Stellar testnet.
async function loadPoolState() {
  try {
    const { commitments } = await readPoolState();
    $("poolCount").textContent = commitments;
  } catch (_) { /* network — leave as-is */ }
  loadActivity();
}

// Live activity feed sourced from on-chain events (RPC getEvents) — the indexing
// tier. Shows the corridor's public footprint (deposits, shielded transfers, tree
// advances, withdrawals) read back from chain; amounts/links stay shielded. Best-
// effort: empty if the RPC has aged the events out (testnet retains ~recent ledgers).
const ACT = {
  deposit: { label: "Deposit into corridor", color: "#ff9445" },
  transfer: { label: "Shielded transfer", color: "#ffb070" },
  root: { label: "Tree advanced (merkle proof)", color: "#8ab4ff" },
  withdraw: { label: "Off-ramp withdrawal", color: "#37d67a" },
};
async function loadActivity() {
  const el = $("activityFeed");
  if (!el) return;
  try {
    const events = await readRecentActivity(8);
    if (!events.length) {
      el.innerHTML = `<div class="empty"><div class="s">No recent on-chain events — testnet RPC retains only recent ledgers (the spendable tree is read from durable state, not events).</div></div>`;
      return;
    }
    el.innerHTML = events.map((e) => {
      const a = ACT[e.kind] || { label: esc(e.kind), color: "#8a847e" }; // esc: defensive, e.kind is a fixed pool symbol today
      const link = e.txHash
        ? `<a class="hash" style="text-decoration:none;" href="${txExplorer(e.txHash)}" target="_blank" rel="noreferrer">${String(e.txHash).slice(0, 8)}… ↗</a>`
        : `<span class="hash">ledger ${e.ledger}</span>`;
      return `<div class="crow">
        <div class="top">
          ${link}
          <span class="st" style="color:${a.color};"><i style="background:${a.color};"></i>${a.label}</span>
        </div>
        <div class="meta"><span>ledger ${e.ledger}</span></div>
      </div>`;
    }).join("");
  } catch (_) { /* best-effort feed */ }
}

const CHIP = {
  corridor: { label: "Deposited", color: "#ff9445" },
  received: { label: "Shielded", color: "#ffb070" },
  offramped: { label: "Off-ramped", color: "#37d67a" },
};

// Sender: create a confidential payment (commitment) entering the corridor.
async function createPayment() {
  if (!connected) { promptConnect("send into the corridor"); return; }
  const usdc = $("amount").value.trim();
  const recipient = $("recipient").value.trim() || "unknown";
  const num = Number(usdc);
  // Reject empty/non-numeric/non-positive. `type=number` permits scientific
  // notation ("1e9") which Number() accepts but BigInt() can't parse, so we
  // normalise to a plain fixed-decimal string before converting to stroops.
  if (!usdc || !isFinite(num) || num <= 0) {
    status.textContent = "Enter a positive USDC amount.";
    return;
  }
  if (num > 1_000_000_000) {
    status.textContent = "Amount too large — keep it under 1,000,000,000 USDC.";
    return;
  }
  const corridor = selectedCorridor().code;
  const amount = usdcToStroops(num.toFixed(7));
  const privKey = randomFieldElement();
  const pubKey = F.toObject(poseidon([privKey])); // pubKey = Poseidon(privKey) -> spendable
  const blinding = randomFieldElement();
  const commitment = F.toObject(poseidon([amount, pubKey, blinding]));

  seq += 1;
  const note = {
    id: seq, // monotonic — notes.length is unstable across shift/unshift
    ref: "PAY-" + String(seq).padStart(3, "0"),
    recipient,
    corridor,
    amount: amount.toString(),
    privKey: privKey.toString(),
    pubKey: pubKey.toString(),
    blinding: blinding.toString(),
    commitment: commitment.toString(),
    leafIndex: leaves.length,
    ts: new Date().toLocaleTimeString(),
    status: "pending",
    onchain: "pending",
  };
  notes.unshift(note);
  setActiveStep(1);
  render();
  status.innerHTML = `<span class="spin">◠</span> ${note.ref} — building compliance + binding proofs, depositing on-chain…`;

  // 1) Real on-chain deposit: compliance + amount-binding proofs -> signed pool.deposit.
  const forge = !!($("compTamper") && $("compTamper").checked);
  const dep = await depositOnChain(note, { forgeSource: forge });
  if (!dep.ok) {
    if (forge) {
      // Expected: the ASP rejected a forged-source deposit on-chain.
      notes.shift(); // drop the rejected attempt from the ledger
      // Auto-clear the forge toggle so the NEXT Send is a normal honest deposit.
      // Otherwise it stays checked and every retry re-forges + bounces back to the
      // Sender panel — which reads as "I sent into the corridor but it keeps coming
      // back" (the demo's educational toggle silently trapping a real send).
      $("compTamper").checked = false;
      $("compTamperLabel").classList.remove("on");
      $("compTamperLabel").setAttribute("aria-checked", "false");
      setActiveStep(0);
      status.innerHTML = `🛡 <b style="color:#ff8a72;">Deposit REJECTED by the ASP on-chain</b> — the compliance proof claimed a source you don't control. The pool pins the source to <i>your authenticated key</i>, so only an approved key you can sign with may deposit. <b>Forge is now off</b> — press <i>Send into corridor →</i> again for a normal deposit.`;
      render(); loadPoolState();
      return;
    }
    note.status = "failed";
    note.onchain = "failed";
    status.textContent = "On-chain deposit failed (note kept locally): " + dep.error;
    render(); saveSession(); loadPoolState();
    return;
  }
  note.onchain = dep.hash || "ok";
  note.status = "corridor";
  render();

  // 2) Advance the on-chain Merkle root so the commitment becomes spendable.
  await registerNote(note);
}

// Register a deposited note's commitment into the on-chain tree (makes it
// spendable). Re-syncs from chain first so we insert at the real next index and
// prove against the real current root; if another deposit lands in between, the
// accumulator rejects our stale old_root (UnknownRoot) and we re-sync + retry, so
// concurrent multi-user deposits self-heal. Reusable: a note whose registration
// failed (network/race) keeps a "Retry registration" button instead of dead-ending.
async function registerNote(note) {
  const commitment = BigInt(note.commitment);
  status.innerHTML = `<span class="spin">◠</span> ${note.ref} deposited ✓ — registering into the on-chain tree…`;
  let reg;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const syncedDep = await syncedLeaves();
    if (syncedDep) leaves = syncedDep;
    // Already in the on-chain tree? (a prior submit landed but its tx response was
    // lost, then we retried) — don't re-insert: that hits LeafAlreadyInserted (#9)
    // and would strand a note that's actually spendable. Adopt the on-chain index.
    const already = leaves.findIndex((l) => l === commitment);
    if (already >= 0) {
      note.leafIndex = already;
      note.root = tree.root(leaves).toString();
      reg = { ok: true };
      break;
    }
    const index = leaves.length;
    note.leafIndex = index;
    const oldRoot = tree.root(leaves);
    const path = tree.pathElements(leaves, index).map((x) => x.toString());
    const newLeaves = [...leaves, commitment];
    const newRoot = tree.root(newLeaves);
    reg = await registerRootOnChain(oldRoot.toString(), note.commitment, newRoot.toString(), index, path);
    if (reg.ok) { leaves = newLeaves; note.root = newRoot.toString(); break; }
    // Another deposit advanced the tree between our sync and submit -> stale
    // old_root (UnknownRoot, code 1). Re-sync and retry — self-heals concurrent
    // multi-user deposits. (Branch on the numeric code, not the friendly string.)
    if (attempt < 3 && reg.code === 1) {
      status.innerHTML = `<span class="spin">◠</span> ${note.ref} — tree advanced by another deposit, re-syncing… (try ${attempt + 1})`;
      continue;
    }
    // The deposit tx confirmed, but the RPC node our register simulation read
    // hasn't caught up yet (read-after-write lag), so it doesn't see the commitment
    // record -> UnknownCommitment (#3). Wait briefly and retry: the record
    // propagates and the next attempt finds it. (Only reachable when the deposit
    // itself succeeded — a failed deposit returns earlier, never calling this.)
    if (attempt < 3 && reg.code === 3) {
      status.innerHTML = `<span class="spin">◠</span> ${note.ref} — confirming the deposit on-chain… (try ${attempt + 1})`;
      await new Promise((r) => setTimeout(r, 4500));
      continue;
    }
    break;
  }
  if (reg.ok) {
    note.spendable = true;
    note.status = "received";
    note.regFailed = false;
    setActiveStep(2);
    status.textContent = `${note.ref} deposited & registered on-chain ✓ — shielded and spendable from the corridor.`;
  } else {
    note.regFailed = true;
    status.textContent = `${note.ref} deposited ✓ — tree registration failed (tap “Retry registration”): ` + reg.error;
  }
  render();
  renderReceiver();
  saveSession();
  loadPoolState();
  return reg.ok;
}

// Corridor (public view): commitments only; amounts hidden. + audit dropdown.
function render() {
  const ledger = $("ledger");
  if (!notes.length) {
    ledger.innerHTML = `<div class="empty"><div class="t">No confidential payments yet.</div><div class="s"><i></i> Reading live pool state from Stellar…</div></div>`;
  } else {
    ledger.innerHTML = notes.map((n) => {
      const c = CHIP[n.status] || { label: n.status === "failed" ? "Failed" : "Pending", color: "#8a847e" };
      const hashLink = (n.onchain && n.onchain !== "pending" && n.onchain !== "failed" && n.onchain !== "ok")
        ? `<a class="hash" style="text-decoration:none;" href="${txExplorer(n.onchain)}" target="_blank" rel="noreferrer">${shortHash(n.commitment)} ↗</a>`
        : `<span class="hash">${shortHash(n.commitment)}</span>`;
      return `<div class="crow">
        <div class="top">
          ${hashLink}
          <span class="st" style="color:${c.color};"><i style="background:${c.color};"></i>${c.label}</span>
        </div>
        <div class="meta">
          <span>${esc(n.ref)}</span>
          <span class="hid">${icon("lock", 11, "#6b645e")} •••• USDC · hidden</span>
        </div>
        ${n.regFailed ? `<button class="btn-retry" data-retry="${n.id}">${icon("reset", 11, "#ff9c52")} Retry registration →</button>` : ""}
      </div>`;
    }).join("");
  }

  // Audit dropdown (only registered/spendable payments are auditable).
  const sel = $("auditSelect");
  const cur = sel.value;
  const auditable = notes.filter((n) => n.spendable);
  sel.innerHTML = '<option value="">— none —</option>' +
    auditable.map((n) => `<option value="${n.id}">${esc(n.ref)} · ${shortHash(n.commitment)}</option>`).join("");
  sel.value = cur;
  renderReceiver();
}

const offramped = new Set();

// Country B receiver: shielded arrivals; reveal+off-ramp to fiat, withdraw on-chain.
function renderReceiver() {
  const el = $("incoming");
  if (!el) return;
  updateCorridorUI(); // keep the receiver badge + rate in sync with the arrival's corridor
  // Withdrawn notes auto-disappear from the list; the JUST-withdrawn one lingers briefly
  // so its "withdrawn ✓ ↗" confirmation + tx link is visible before it clears.
  const arrivals = notes.filter((n) => n.spendable && (!n.withdrawn || n.justWithdrawn));
  if (!arrivals.length) {
    el.innerHTML = `<div class="empty"><div class="t">Nothing received yet.</div><div class="s" style="color:#6b645e;">Send a payment from Country A →</div></div>`;
    return;
  }
  el.innerHTML = arrivals.map((n) => {
    const opened = offramped.has(n.id);
    const usdc = fmtUsdc(BigInt(n.amount));
    // Off-ramp corridor = the receiver's chosen local currency (defaults to the note's
    // corridor, but the receiver can convert the SAME note to a different corridor).
    const cor = corridorByCode(n.offCorridor || n.corridor);
    // Prefer the on-chain quote (pool read Reflector) when the reveal fetched one;
    // otherwise fall back to the client rate.
    const onchainQuote = typeof n.localQuote === "number";
    const local = onchainQuote ? n.localQuote : Number(usdc) * cor.rate;
    const localStr = local.toLocaleString("en-US", { maximumFractionDigits: local >= 1000 ? 0 : 2 });
    const chipColor = opened ? "#37d67a" : "#ffb070";
    const chipLabel = opened ? "Off-ramped" : "Shielded";

    // Per-note off-ramp corridor picker (only while the note is still spendable).
    const offSel = (n.spendable && !n.withdrawn)
      ? `<div class="offramp-row"><span class="offramp-lbl">Off-ramp to</span><select class="offramp-sel" data-offsel="${n.id}" aria-label="Off-ramp corridor">${CORRIDORS.map((c) => `<option value="${c.code}"${c.code === (n.offCorridor || n.corridor) ? " selected" : ""}>${c.country} · ${c.currency}</option>`).join("")}</select></div>`
      : "";

    let body;
    if (opened) {
      const lbl = onchainQuote
        ? `$${usdc} USDC revealed · rate read on-chain by the pool from Reflector`
        : `$${usdc} USDC revealed`;
      body = `<div class="mxn"><span class="amt">+ ${cor.symbol}${localStr} ${cor.currency}</span><span class="lbl">${lbl}</span></div>`;
    } else {
      body = `<button class="btn-reveal" data-reveal="${n.id}">Reveal &amp; off-ramp →</button>`;
    }

    let wd = "";
    if (n.withdrawn) {
      wd = `<a class="wd-done" style="text-decoration:none;" href="${txExplorer(n.withdrawn)}" target="_blank" rel="noreferrer">${icon("sealCheck", 12, "#5fe3a0")} withdrawn on-chain ↗</a>`;
    } else if (n.withdrawing) {
      wd = `<div class="wd-pend"><span class="spin">◠</span> withdrawing on-chain…</div>`;
    } else if (n.spendable) {
      wd = `<button class="btn-wd" data-withdraw="${n.id}">${icon("offramp", 12, "#cfc8c1")} Withdraw on-chain →</button>`;
    }
    const exp = (n.spendable && !n.withdrawn)
      ? `<button class="btn-export" data-export="${n.id}">${icon("link", 11, "#8a847e")} Export bearer note</button>` : "";

    return `<div class="arrival${opened ? " done" : ""}">
      <div class="top"><span class="ref">${esc(n.ref)}${n.imported ? " · imported" : " · from US"}</span><span class="chip" style="color:${chipColor};">${chipLabel}</span></div>
      ${offSel}
      <div class="body">${body}</div>
      ${wd}${exp}
    </div>`;
  }).join("");
}

// Spend a deposited note on-chain: build a transfer proof, submit pool.withdraw.
async function withdrawNote(note) {
  if (!note.spendable || note.withdrawn || note.withdrawing) return;
  if (!connected) { promptConnect("withdraw on-chain"); return; }
  note.withdrawing = true;
  renderReceiver();
  status.innerHTML = `<span class="spin">◠</span> ${note.ref} — building shielded transfer proof…`;
  try {
    const amt = BigInt(note.amount);
    const W = amt; // release the note's full amount
    const dPriv = randomFieldElement(), dBlind = randomFieldElement();
    const dPub = F.toObject(poseidon([dPriv]));
    const dCommit = F.toObject(poseidon([0n, dPub, dBlind]));
    const o0Priv = randomFieldElement(), o0Blind = randomFieldElement();
    const o0Pub = F.toObject(poseidon([o0Priv]));
    const o0Amt = amt - W; // change note left in the pool (0 for a full withdraw)
    const o0Commit = F.toObject(poseidon([o0Amt, o0Pub, o0Blind]));
    const o1Priv = randomFieldElement(), o1Blind = randomFieldElement();
    const o1Pub = F.toObject(poseidon([o1Priv]));
    const o1Commit = F.toObject(poseidon([0n, o1Pub, o1Blind]));
    // Re-sync the tree from chain, build the proof against the current root, submit.
    // Retry on UnknownRoot (#1): syncedLeaves() reads leaves() and current_root in
    // two RPC calls, so lag can momentarily reconstruct a stale root the contract no
    // longer recognizes — re-sync and retry, exactly as registerNote does. Locate the
    // note's REAL on-chain index by commitment (not a stale local leafIndex), or the
    // nullifier and Merkle path won't match.
    const recipient = activeAddress();
    const pubAmount = ((R - W) % R).toString();
    const extDataHash = extDataHashFor(recipient, pubAmount);
    // Min-receive settlement gate: for oracle-backed corridors, read the live local
    // rate and ask the pool to refuse releasing below 99% of it (1% slippage). The
    // pool re-reads Reflector on-chain AT settlement, so the displayed quote becomes
    // load-bearing for the actual fund release — not just a number. Only gate when we
    // have a fresh quote (oracle live); a null quote -> no gate, so a transient read
    // failure never blocks a withdraw.
    let offrampSym, minLocalOut;
    const cor = corridorByCode(note.offCorridor || note.corridor);
    if (cor && cor.oracle) {
      // Quote the SAME whole-USDC unit the contract gate prices: it floors
      // amount/10^7, so we must too — else a fractional note (e.g. $20.50) makes the
      // frontend min (rounded up) exceed the contract's floored quote and the gate
      // wrongly rejects forever. Skip the gate when the floored unit is 0 (<1 USDC).
      const usdcWhole = BigInt(note.amount) / STROOPS; // matches lib.rs: amount / USDC_STROOPS
      if (usdcWhole > 0n) {
        // Compute the floor from the MEDIAN quote (offramp_quote_twap, 5 records) — the
        // exact basis the on-chain gate enforces — so the client floor and the gate
        // agree, and a manipulated spot can't desync them. null (thin/dead feed) -> no
        // gate, so a transient read failure never blocks a withdraw.
        const q = await offrampQuoteTwap(cor.oracle, Number(usdcWhole), 5);
        if (q != null && q > 0) { offrampSym = cor.oracle; minLocalOut = Math.floor(q * 0.99); }
      }
    }
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const syncedWd = await syncedLeaves();
      if (syncedWd) leaves = syncedWd;
      const realIndex = leaves.findIndex((l) => l === BigInt(note.commitment));
      if (realIndex < 0) {
        note.withdrawing = false;
        status.textContent = `${note.ref} isn't registered in the on-chain tree yet — can't withdraw.`;
        renderReceiver();
        return;
      }
      note.leafIndex = realIndex;
      const n0 = F.toObject(poseidon([BigInt(note.commitment), BigInt(realIndex), BigInt(note.privKey)]));
      const n1 = F.toObject(poseidon([dCommit, 0n, dPriv]));
      const root = tree.root(leaves);
      const path = tree.pathElements(leaves, realIndex).map((x) => x.toString());
      const input = {
        root: root.toString(), publicAmount: pubAmount, extDataHash,
        inputNullifier: [n0.toString(), n1.toString()],
        outputCommitment: [o0Commit.toString(), o1Commit.toString()],
        inAmount: [note.amount, "0"],
        inPrivKey: [note.privKey, dPriv.toString()],
        inBlinding: [note.blinding, dBlind.toString()],
        inLeafIndex: [String(realIndex), "0"],
        inPathElements: [path, new Array(10).fill("0")],
        outAmount: [o0Amt.toString(), "0"],
        outPubkey: [o0Pub.toString(), o1Pub.toString()],
        outBlinding: [o0Blind.toString(), o1Blind.toString()],
      };
      // ?v bumped when the transfer circuit changes so a returning visitor never proves
      // with a stale circuit the new verifier rejects.
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "./circuit/transfer.wasm?v=2", "./circuit/transfer_final.zkey?v=2");
      status.innerHTML = `<span class="spin">◠</span> ${note.ref} — releasing tokens on-chain…`;
      res = await withdrawSubmit(proof, publicSignals, recipient, W, offrampSym, minLocalOut);
      if (res.ok) break;
      if (attempt < 3 && res.code === 1) {
        status.innerHTML = `<span class="spin">◠</span> ${note.ref} — tree moved on, re-syncing… (try ${attempt + 1})`;
        continue;
      }
      break;
    }
    note.withdrawing = false;
    if (res.ok) {
      note.withdrawn = res.hash || "ok";
      status.textContent = `${note.ref} withdrawn on-chain ✓ — the note was spent and tokens released from the pool.`;
    } else if (res.code === 2) {
      // NullifierUsed: this note's nullifier is already on-chain. Either a prior
      // withdraw whose response we lost, or a genuine double-spend attempt — both
      // mean the funds are settled and there's nothing left to release. Mark it
      // spent rather than showing a scary failure for the lost-response case.
      note.withdrawn = "spent";
      status.textContent = `${note.ref} — already spent (nullifier on-chain). Tokens were released; nothing left to withdraw.`;
    } else {
      status.textContent = "Withdraw failed: " + res.error;
    }
  } catch (e) {
    note.withdrawing = false;
    status.textContent = "Withdraw failed: " + ((e && e.message) || e);
  }
  // Withdrawn note auto-disappears: show the "withdrawn ✓ ↗" confirmation for a
  // moment, then clear it from the arrivals list (the on-chain record persists).
  if (note.withdrawn) {
    note.justWithdrawn = true;
    setTimeout(() => { note.justWithdrawn = false; renderReceiver(); saveSession(); }, 4500);
  }
  renderReceiver();
  saveSession();
  loadPoolState();
}

// Bearer note: a note IS the spendable asset. Export it as a portable string so a
// DIFFERENT person (the receiver) can import it elsewhere and withdraw — the
// corridor becomes truly peer-to-peer (the on-chain tree reconstructs anywhere,
// the recipient binding sends funds to whoever withdraws). Demo secrets only.
async function exportNote(note) {
  const payload = {
    v: 1, ref: note.ref, amount: note.amount, privKey: note.privKey,
    pubKey: note.pubKey, blinding: note.blinding, commitment: note.commitment,
    corridor: note.corridor, // carry the corridor so the receiver off-ramps to the right currency
  };
  const str = "tukar1:" + btoa(JSON.stringify(payload));
  const box = $("exportBox");
  box.style.display = "";
  box.innerHTML = `<div class="eh">BEARER NOTE · ${esc(note.ref)} <button class="btn-copy" data-copysrc="exportEsTxt">Copy</button></div>
    <div class="es" id="exportEsTxt">${esc(str)}</div>
    <div class="qr" id="exportQr"></div>
    <div class="ec">Whoever holds this string can withdraw the note. Scan the code, or paste the string into "Import" on another device to receive it.</div>`;
  copyToClipboard(str);
  status.textContent = `${note.ref} exported as a bearer note — hand the string (or QR) to the receiver.`;
  qrInto("exportQr", str, "bearer note QR");
}

// Render a scannable QR into a slot. Lazy-loaded so a CDN hiccup degrades
// gracefully — the copyable string alongside it stays the source of truth.
async function qrInto(slotId, str, alt) {
  try {
    const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.3");
    const url = await QRCode.toDataURL(str, { margin: 1, width: 168, errorCorrectionLevel: "L", color: { dark: "#0a0705", light: "#f3ad79" } });
    const slot = $(slotId);
    if (slot) slot.innerHTML = `<img alt="${alt}" src="${url}" width="168" height="168" />`;
  } catch (_) {
    const slot = $(slotId);
    if (slot) slot.innerHTML = `<span class="qr-fallback">QR unavailable — copy the string instead.</span>`;
  }
}

// Payment request (reverse direction): the receiver asks for an amount; the sender
// loads it to pre-fill the corridor send form. A request is public (no secrets) —
// it just carries an amount, a memo, and the receiver's address as the label.
function createRequest() {
  const amt = parseFloat($("reqAmount").value);
  if (!(amt > 0)) { status.textContent = "Enter an amount to request."; return; }
  const addr = activeAddress();
  const memo = `to ${addr.slice(0, 4)}..${addr.slice(-4)}`; // ASCII only (btoa is Latin1)
  const str = "tukreq1:" + btoa(JSON.stringify({ v: 1, kind: "req", amount: String(amt), memo, addr }));
  const box = $("reqBox");
  box.style.display = "";
  box.innerHTML = `<div class="eh">PAYMENT REQUEST · ${amt} USDC <button class="btn-copy" data-copysrc="reqEsTxt">Copy</button></div>
    <div class="es" id="reqEsTxt">${esc(str)}</div>
    <div class="qr" id="reqQr"></div>
    <div class="ec">→ paste this into "Load" at the top of the Sender panel (or scan the QR) to fill in the amount and recipient.</div>`;
  copyToClipboard(str);
  status.textContent = `Requested ${amt} USDC — hand the string (or QR) to the sender.`;
  qrInto("reqQr", str, "payment request QR");
}

// Best-effort clipboard write; the Copy button gives honest per-action feedback.
function copyToClipboard(str) {
  if (navigator.clipboard) navigator.clipboard.writeText(str).catch(() => {});
}

function loadRequest() {
  const raw = $("reqLoadInput").value.trim();
  if (!raw) return;
  try {
    const json = JSON.parse(atob(raw.replace(/^tukreq1:/, "")));
    if (json.kind !== "req") throw new Error("not a Tukar payment request");
    if (!/^\d+(\.\d{1,7})?$/.test(String(json.amount))) throw new Error("invalid request amount");
    const label = (typeof json.addr === "string" && /^G[A-Z2-7]{55}$/.test(json.addr))
      ? `Requested payee · ${json.addr.slice(0, 6)}…${json.addr.slice(-4)}`
      : "requested payee";
    $("amount").value = json.amount;
    $("recipient").value = label;
    $("reqLoadInput").value = "";
    setActiveStep(0);
    status.textContent = `Loaded a request for ${json.amount} USDC — review and hit "Send into corridor".`;
  } catch (e) {
    status.textContent = "Couldn't load that request: " + ((e && e.message) || "invalid string");
  }
}

function importNote() {
  const raw = $("importInput").value.trim();
  if (!raw) return;
  try {
    const json = JSON.parse(atob(raw.replace(/^tukar1:/, "")));
    // Validate every secret/field is a bare decimal field element — a malformed
    // value would otherwise crash BigInt()/render and break the whole panel.
    for (const k of ["amount", "privKey", "pubKey", "blinding", "commitment"]) {
      if (!isFieldStr(json[k])) throw new Error("malformed or missing field: " + k);
    }
    if (notes.some((n) => n.commitment === json.commitment)) {
      status.textContent = "That note is already in this wallet.";
      return;
    }
    seq += 1;
    const safeRef = (typeof json.ref === "string" && /^[\w .·#-]{1,24}$/.test(json.ref))
      ? json.ref : ("PAY-" + String(seq).padStart(3, "0"));
    const note = {
      id: seq, ref: safeRef,
      recipient: "you", amount: json.amount, privKey: json.privKey, pubKey: json.pubKey,
      blinding: json.blinding, commitment: json.commitment, leafIndex: 0,
      // preserve the sender's corridor so the off-ramp + min-receive gate use the right
      // currency; corridorByCode falls back to the first corridor for a missing/unknown code.
      corridor: corridorByCode(json.corridor).code,
      ts: new Date().toLocaleTimeString(), status: "received", spendable: true,
      imported: true, onchain: "ok",
    };
    notes.unshift(note);
    $("importInput").value = "";
    $("exportBox").style.display = "none";
    setActiveStep(2);
    render(); renderReceiver(); saveSession();
    status.textContent = `Imported ${note.ref} — it's now withdrawable here (the tree is verified from chain on withdraw).`;
  } catch (e) {
    status.textContent = "Couldn't import that note: " + ((e && e.message) || "invalid string");
  }
}

// Render the regulator proof-view box (idle/proving/verified/rejected).
function renderProof(state, data = {}) {
  proofState = state;
  const result = $("result");
  const M = {
    idle: { border: "rgba(255,255,255,0.07)", bg: "rgba(0,0,0,0.2)", color: "#cfc8c1", ic: icon("shield", 16, "#8a847e"), title: "Ready", body: "Zero-knowledge prover loaded." },
    proving: { border: "rgba(255,122,26,0.4)", bg: "rgba(255,122,26,0.06)", color: "#ff9c52", ic: icon("spark", 16, "#ff9c52"), title: "Proving in browser…", body: "Generating a Groth16 proof over BN254. Secrets never leave the device." },
    verified: { border: "rgba(55,214,122,0.4)", bg: "rgba(55,214,122,0.07)", color: "#5fe3a0", ic: icon("sealCheck", 16, "#5fe3a0"), title: "Proof verified", body: data.body || "" },
    rejected: { border: "rgba(255,90,70,0.45)", bg: "rgba(255,90,70,0.07)", color: "#ff8a72", ic: icon("sealX", 16, "#ff8a72"), title: "InvalidProof", body: data.body || "" },
  }[state];
  result.style.border = "1px solid " + M.border;
  result.style.background = M.bg;
  result.innerHTML = `
    <div class="ph">${M.ic}<span class="pt" style="color:${M.color};">${M.title}</span></div>
    <div class="pb">${M.body}</div>
    ${data.mono ? `<div class="pmono">${data.mono}</div>` : ""}
    ${data.onchain ? `<div class="pmono" data-onchain>${data.onchain}</div>` : ""}
    ${state === "proving" ? `<div class="proofbar"><i></i></div>` : ""}`;
}

// Regulator: holder generates a disclosure proof; regulator verifies on-chain.
async function proveAndVerify() {
  const id = Number($("auditSelect").value);
  const note = notes.find((n) => n.id === id);
  if (!note) { status.textContent = "Select a confidential payment to audit first."; return; }

  const tamper = $("tamper").checked;
  const auditContextHash = contextToField($("auditCtx").value).toString();
  $("proveBtn").disabled = true;
  $("proveBtn").classList.add("busy");
  $("proveBtn").textContent = "Proving…";
  setActiveStep(3);
  renderProof("proving");
  status.innerHTML = '<span class="spin">◠</span> Generating zero-knowledge proof in your browser…';

  try {
    const input = {
      commitment: note.commitment, disclosedAmount: note.amount, auditContextHash,
      amount: note.amount, pubKey: note.pubKey, blinding: note.blinding,
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

    // Tamper mode: regulator is handed a FALSE claimed amount alongside the proof.
    let claimed = publicSignals.slice();
    if (tamper) claimed[1] = (BigInt(publicSignals[1]) + 12345n).toString();
    const ok = await snarkjs.groth16.verify(vkey, claimed, proof);
    const link = `<a href="${explorer(DISCLOSURE_VERIFIER)}" target="_blank" rel="noreferrer">${short(DISCLOSURE_VERIFIER)} ↗</a>`;

    if (ok) {
      renderProof("verified", {
        body: `Disclosed amount: <b style="color:#5fe3a0;">$${fmtUsdc(claimed[1])} USDC</b>. Nothing else is revealed — no keys, no blinding, no other payments.`,
        mono: `commitment ${short(note.commitment)} · context ${short(auditContextHash)}`,
        onchain: "⛓ confirming on the live Stellar verifier…",
      });
      status.textContent = "Disclosure verified in your browser. Confirming on Stellar…";
    } else {
      renderProof("rejected", {
        body: `Claimed amount <b style="color:#ff8a72;">$${fmtUsdc(claimed[1])} USDC</b> contradicts the proof. A false claim cannot pass verification.`,
        onchain: "⛓ confirming on the live Stellar verifier…",
      });
      status.textContent = "Tampered claim rejected in your browser. Confirming on Stellar…";
    }

    // Live on-chain verification by the deployed Stellar verifier (read-only RPC).
    try {
      const oc = await verifyDisclosureOnChain(proof, claimed);
      const el = $("result").querySelector("[data-onchain]");
      if (ok && oc.verified) {
        if (el) el.innerHTML = `⛓ <b style="color:#5fe3a0;">Verified on-chain</b> too — by the live Stellar verifier ${link}`;
        // Only now upgrade the headline from "Proof verified" to the on-chain claim.
        const pt = $("result").querySelector(".pt");
        if (pt) pt.textContent = "Verified on-chain";
        status.textContent = "Disclosure verified — in your browser AND on Stellar. Privacy preserved, compliance satisfied.";
      } else if (!ok && !oc.verified) {
        if (el) el.innerHTML = `⛓ The live Stellar verifier ${link} <b style="color:#ff8a72;">also rejected it</b> (InvalidProof).`;
        status.textContent = "Tampered claim rejected — in your browser AND on-chain. The proof is sound.";
      } else if (el) {
        el.textContent = `⛓ on-chain result: ${oc.verified ? "verified" : "rejected"}`;
      }
    } catch (_) {
      const el = $("result").querySelector("[data-onchain]");
      if (el) el.textContent = "⛓ on-chain check unavailable (network).";
    }
  } catch (e) {
    renderProof("rejected", { body: `Proof generation failed: ${(e && e.message) || e}. A disclosure that contradicts the committed amount cannot even be proven.` });
    status.textContent = "Proof rejected at generation — soundness holds.";
  } finally {
    $("proveBtn").disabled = false;
    $("proveBtn").classList.remove("busy");
    $("proveBtn").textContent = "Generate & verify disclosure proof";
  }
}

function resetUI() {
  notes = [];
  leaves = [];
  offramped.clear();
  seq = 0;
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  setActiveStep(0);
  $("amount").value = "500";
  if ($("corridor")) $("corridor").value = "MX";
  updateCorridorUI();
  $("recipient").value = "María · Mexico City";
  $("auditCtx").value = "2026-Q2 · CNBV";
  $("tamper").checked = false;
  $("tamperLabel").classList.remove("on");
  $("compTamper").checked = false;
  $("compTamperLabel").classList.remove("on");
  $("compTamperLabel").setAttribute("aria-checked", "false");
  $("importInput").value = "";
  $("exportBox").style.display = "none";
  $("reqLoadInput").value = "";
  $("reqBox").style.display = "none";
  renderProof("idle");
  render();
  status.textContent = "Reset · session cleared (on-chain commitments persist).";
  loadPoolState();
}

// ---- wiring ----
$("sendBtn").addEventListener("click", async () => {
  if (!poseidon) { status.textContent = "Prover still loading — one moment…"; return; }
  $("sendBtn").disabled = true;
  $("sendBtn").classList.add("busy");
  $("sendBtn").textContent = "Building compliance proof…";
  try { await createPayment(); }
  finally {
    $("sendBtn").disabled = false;
    $("sendBtn").classList.remove("busy");
    $("sendBtn").textContent = "Send into corridor →";
  }
});
$("proveBtn").addEventListener("click", () => {
  if (!poseidon) { status.textContent = "Prover still loading — one moment…"; return; }
  proveAndVerify();
});
function toggleTamper() {
  const cb = $("tamper");
  cb.checked = !cb.checked;
  $("tamperLabel").classList.toggle("on", cb.checked);
  $("tamperLabel").setAttribute("aria-checked", cb.checked ? "true" : "false");
}
$("tamperLabel").addEventListener("click", toggleTamper);
$("tamperLabel").addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleTamper(); }
});
// Compliance "forge source" toggle (Sender panel) — a custom keyboard checkbox.
function toggleCompTamper() {
  const cb = $("compTamper");
  cb.checked = !cb.checked;
  $("compTamperLabel").classList.toggle("on", cb.checked);
  $("compTamperLabel").setAttribute("aria-checked", cb.checked ? "true" : "false");
}
$("compTamperLabel").addEventListener("click", toggleCompTamper);
$("compTamperLabel").addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleCompTamper(); }
});
$("resetBtn").addEventListener("click", resetUI);
$("importBtn").addEventListener("click", importNote);
$("importInput").addEventListener("keydown", (e) => { if (e.key === "Enter") importNote(); });
$("corridor").addEventListener("change", () => {
  $("recipient").value = selectedCorridor().recipient;
  updateCorridorUI();
});
$("reqBtn").addEventListener("click", createRequest);
$("reqLoadBtn").addEventListener("click", loadRequest);
// Retry a stranded note's tree registration (deposit succeeded, register didn't).
$("ledger").addEventListener("click", (e) => {
  const rt = e.target.closest("[data-retry]");
  if (!rt) return;
  const n = notes.find((x) => x.id === Number(rt.dataset.retry));
  if (n && !n.spendable) { n.regFailed = false; render(); registerNote(n); }
});
$("reqLoadInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadRequest(); });
// Copy buttons on exported bearer notes / requests — honest per-click feedback.
document.addEventListener("click", (e) => {
  const cb = e.target.closest(".btn-copy");
  if (!cb) return;
  const src = $(cb.dataset.copysrc);
  if (!src) return;
  const reset = () => setTimeout(() => { cb.textContent = "Copy"; }, 1600);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(src.textContent).then(() => { cb.textContent = "Copied ✓"; reset(); })
      .catch(() => { cb.textContent = "Select & copy"; reset(); });
  } else { cb.textContent = "Select & copy"; reset(); }
});
$("incoming").addEventListener("click", async (e) => {
  const off = e.target.closest("[data-reveal]");
  if (off) {
    const id = Number(off.dataset.reveal);
    offramped.add(id);
    renderReceiver();
    saveSession();
    const n = notes.find((x) => x.id === id);
    const cor = n ? corridorByCode(n.offCorridor || n.corridor) : null;
    const cur = cor ? cor.currency : "local fiat";
    status.textContent = `Off-ramp: amount revealed at the corridor edge to convert to ${cur}.`;
    // For a Reflector-backed corridor, get the figure the way production would: ask
    // the POOL CONTRACT, which reads Reflector on-chain and returns the local fiat.
    if (n && cor && cor.oracle) {
      try {
        const usdc = Number(fmtUsdc(BigInt(n.amount)));
        const q = await offrampQuote(cor.oracle, usdc);
        if (q != null) {
          n.localQuote = q;
          renderReceiver();
          saveSession();
          console.log(`[tukar] off-ramp quote ${cor.currency} computed on-chain by the pool (reads Reflector): ${q}`);
        }
      } catch (_) { /* keep the client-rate figure */ }
    }
    return;
  }
  const ex = e.target.closest("[data-export]");
  if (ex) {
    const n = notes.find((x) => x.id === Number(ex.dataset.export));
    if (n) exportNote(n);
    return;
  }
  const wd = e.target.closest("[data-withdraw]");
  if (wd) {
    const n = notes.find((x) => x.id === Number(wd.dataset.withdraw));
    if (n) withdrawNote(n);
  }
});
// Off-ramp corridor change: convert the SAME note to a different local currency. The
// on-chain USDC amount is unchanged — only the revealed local figure (and, for an
// oracle corridor, the min-receive gate) follow the chosen corridor.
$("incoming").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-offsel]");
  if (!sel) return;
  const n = notes.find((x) => x.id === Number(sel.dataset.offsel));
  if (!n) return;
  n.offCorridor = sel.value;
  n.localQuote = undefined; // force a re-quote for the new corridor
  saveSession();
  renderReceiver();
  const cor = corridorByCode(n.offCorridor);
  if (offramped.has(n.id) && cor && cor.oracle) {
    try {
      const q = await offrampQuote(cor.oracle, Number(fmtUsdc(BigInt(n.amount))));
      if (q != null) { n.localQuote = q; saveSession(); renderReceiver(); }
    } catch (_) { /* keep the client-rate figure */ }
  }
});

// Optional Freighter wallet: when connected, deposits are signed by the user's
// own wallet (with a one-click testnet faucet); otherwise the embedded demo key
// is used, so the no-install demo always works.
// On-chain actions (Send/Withdraw) require an EXPLICIT connection — no silent
// signing. You connect either Freighter (your own wallet) or the built-in testnet
// key (a real throwaway key signing real testnet txs, no install). Both are real;
// neither is a mock. `connected` gates the buttons.
let walletConn = null;
let connected = false;
const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function setSendGate() {
  const sb = $("sendBtn");
  if (sb) sb.disabled = !connected;
  const h = $("connectHint");
  if (h) h.style.display = connected ? "none" : "";
}
function promptConnect(action) {
  status.innerHTML = `Connect a wallet — or click <b>“Use testnet key”</b> in the top bar — to ${action}.`;
}
function showConnected(tagHtml, msg) {
  connected = true;
  $("walletTag").innerHTML = tagHtml;
  $("walletBtn").style.display = "none";
  $("demoKeyBtn").textContent = "Disconnect";
  $("demoKeyBtn").dataset.role = "disconnect";
  setSendGate();
  if (msg) status.textContent = msg;
}
function showDisconnected(msg) {
  walletDisconnect(); // resets the signer back to the built-in key
  walletConn = null;
  connected = false;
  $("walletTag").innerHTML = '<span style="opacity:.6;font-size:11px">not connected</span>';
  $("walletBtn").style.display = "";
  $("walletBtn").textContent = "Connect wallet";
  $("demoKeyBtn").textContent = "Use testnet key";
  $("demoKeyBtn").dataset.role = "connect";
  setSendGate();
  if (msg) status.textContent = msg;
}

// "Use testnet key" — activate the built-in throwaway testnet key as an explicit
// connection (real key, real testnet txs, no install). Doubles as Disconnect.
function onDemoKeyClick() {
  if ($("demoKeyBtn").dataset.role === "disconnect") {
    localStorage.removeItem("tukar:conn"); // forget the persisted connection
    showDisconnected("Disconnected. Connect a wallet (or the built-in testnet key) to send.");
    return;
  }
  walletDisconnect(); // ensure the default built-in-key signer is active
  walletConn = null;
  showConnected(
    `<b>testnet key</b> · ${shortAddr(activeAddress())}`,
    "Connected with the built-in testnet key — real testnet transactions, no install. (Connect Freighter to sign with your own wallet.)",
  );
  // Persist so navigating between step pages (or refreshing one) keeps the connection.
  localStorage.setItem("tukar:conn", "demo");
}

async function onWalletClick() {
  $("walletBtn").disabled = true;
  status.innerHTML = '<span class="spin">◠</span> Connecting Freighter… (approve in the extension)';
  try {
    const { address, signTransaction } = await walletConnect();
    walletConn = { address };
    localStorage.removeItem("tukar:conn"); // a Freighter session isn't auto-restored (needs re-approval)
    showConnected(`<b>${shortAddr(address)}</b>`, `Wallet connected (${shortAddr(address)}) — transactions signed by Freighter.`);
    // Funding (friendbot XLM + USDC trustline + faucet) is best-effort: the wallet
    // is already connected, so a transient faucet failure must NOT drop it.
    try {
      await setupTestnetFunds(address, signTransaction, (m) => {
        status.innerHTML = `<span class="spin">◠</span> Wallet setup — ${m}`;
      });
      status.textContent = `Wallet connected (${shortAddr(address)}) — transactions signed by Freighter.`;
    } catch (fundErr) {
      status.textContent = `Wallet connected (${shortAddr(address)}) — testnet funding step failed (${(fundErr && fundErr.message) || fundErr}); you may need XLM + a USDC trustline before depositing.`;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/not detected|not available|failed to load/i.test(msg)) {
      status.innerHTML =
        'No Freighter wallet detected. <a href="https://www.freighter.app/" target="_blank" rel="noreferrer" style="color:#c9a36a;text-decoration:underline;font-weight:600">Install Freighter →</a> ' +
        'then click Connect again — or click “Use testnet key” to run on the built-in testnet key.';
    } else {
      status.textContent = "Wallet error: " + msg;
    }
  } finally {
    $("walletBtn").disabled = false;
  }
}
$("walletBtn").addEventListener("click", onWalletClick);
$("demoKeyBtn").addEventListener("click", onDemoKeyClick);

// Real anchor on-ramp: SEP-10 auth + SEP-24 interactive USDC deposit (no mock).
if ($("anchorBtn")) $("anchorBtn").addEventListener("click", async () => {
  const btn = $("anchorBtn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening anchor…";
  status.innerHTML = `<span class="spin">◠</span> Anchor: authenticating (SEP-10) + opening a USDC deposit (SEP-24)…`;
  try {
    const { url, id, asset } = await anchorOnramp();
    const w = window.open(url, "_blank", "noopener,noreferrer,width=460,height=720");
    status.innerHTML = w
      ? `Anchor on-ramp opened for <b>${asset}</b> — complete the deposit in the anchor window (real SEP-24 session · tx ${esc(String(id).slice(0, 8))}…).`
      : `Anchor session ready for <b>${asset}</b> — allow pop-ups, or open: <a href="${url}" target="_blank" rel="noreferrer" style="color:#c9a36a;text-decoration:underline">deposit ↗</a>`;
  } catch (e) {
    status.textContent = "Anchor on-ramp failed: " + ((e && e.message) || e);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Per-step navigation = LITERAL page changes. Clicking the flow strip or Back/Next
// does a real browser navigation (full page load) to /demo/<slug> — each corridor
// step is genuinely its own page, not a client-side panel swap. (Auto-advance from
// mid-transaction code still uses setActiveStep/pushState, since a full reload there
// would abort the in-flight deposit/withdraw.) State survives via localStorage.
function navigateToStep(i) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  const target = "/demo/" + STEPS[i].slug;
  if (location.pathname !== target) location.assign(target); // real navigation
}
if ($("navPrev")) $("navPrev").addEventListener("click", () => navigateToStep(stepIndexFromPath() - 1));
if ($("navNext")) $("navNext").addEventListener("click", () => navigateToStep(stepIndexFromPath() + 1));
for (let i = 0; i < 4; i++) {
  const f = $("fn" + i);
  if (!f) continue;
  f.style.cursor = "pointer";
  f.setAttribute("role", "link");
  f.setAttribute("tabindex", "0");
  f.addEventListener("click", () => navigateToStep(i));
  f.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateToStep(i); } });
}

showDisconnected();

// Set the correct single panel from the URL IMMEDIATELY (synchronously, before the
// async prover init below) so deep routes don't flash the default Sender panel, and
// no route flashes all four while init() loads the prover/tree.
showStep(stepIndexFromPath(), false);

console.log("[tukar] app.js module executed — wiring UI");
init();
