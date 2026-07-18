// Tukar — live Stellar testnet from the browser.
//  * reads (balance, verify) are read-only RPC simulations — no key needed;
//  * deposit() is a real signed write. It uses a THROWAWAY testnet demo key
//    (non-admin, holds only free testnet XLM) embedded below so anyone can try
//    the demo without a wallet. Never reuse this pattern for real funds.
// Pinned to an exact version (not a floating @14) so esm.sh can't silently serve a
// different minor at load time — matches the exact-pinning of the other CDN deps.
const mod = await import("https://esm.sh/@stellar/stellar-sdk@14.6.1");
const Sdk = mod.default ?? mod;
import * as snarkjs from "https://esm.sh/snarkjs@0.7.5";
import sha3 from "https://esm.sh/js-sha3@0.9.3";
const keccak256 = sha3.keccak256 ?? sha3.default?.keccak256;

// BN254 scalar field modulus (for reducing the ext-data keccak into a field element)
const FIELD_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Throwaway testnet demo key (non-admin). Used only to sign deposit txs so the
// browser demo can write on-chain. Public on purpose; holds only free testnet XLM.
const DEMO_SECRET = "SDFJSXC3W4QM43KLLX7MQMPUU3SHJZ45UEYOODCWVE3QZDWWB5ZSN6OB";

const RPC = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
export const POOL = "CD4CIE7IZSU5J7ZHVPQVEMYKO6CP7RTU3XT7TGUNUCOLKZGINVQZKFFS";
export const DISCLOSURE_VERIFIER = "CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET";
// Reflector — Stellar's decentralized SEP-40 FX oracle (testnet, base = USD).
// We read USD->local rates from this live contract for the off-ramp figure.
export const REFLECTOR_FX = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";
const SOURCE = "GA2DZZWGTZ4NGGNM3FQERYXLCHXQ2XXRC7OCHUFCXDC5D4HLEYFF4IWM"; // public key, used only to build a simulation tx

const server = new Sdk.rpc.Server(RPC);

async function simulate(contractId, method, ...args) {
  const source = await server.getAccount(SOURCE);
  const c = new Sdk.Contract(contractId);
  const tx = new Sdk.TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(c.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(sim)) {
    return { ok: false, error: sim.error };
  }
  return { ok: true, value: Sdk.scValToNative(sim.result.retval) };
}

// Reflector's oracle decimals (queried once, cached). The FX feed reports prices
// scaled by 10^decimals; we read it rather than hardcode so a feed change can't
// silently 1000x the off-ramp number.
let _fxDecimals = null;
/**
 * Read a live USD->local FX rate from the Reflector SEP-40 oracle (on-chain).
 * `symbol` is the quote currency code (e.g. "MXN"); the oracle's base is USD.
 * Reflector returns the USD price of 1 local unit, so the USD->local rate is
 * its reciprocal. Returns { rate, timestamp } (local units per 1 USD), or null
 * if the feed doesn't carry this currency / the read fails.
 */
export async function readReflectorFx(symbol) {
  try {
    if (_fxDecimals === null) {
      const d = await simulate(REFLECTOR_FX, "decimals");
      _fxDecimals = d.ok ? Number(d.value) : 14;
    }
    // Reflector's Asset is `enum { Stellar(Address), Other(Symbol) }`; the fiat
    // feeds use the Other(Symbol) variant, encoded as a 2-element vec ScVal.
    const asset = Sdk.xdr.ScVal.scvVec([
      Sdk.xdr.ScVal.scvSymbol("Other"),
      Sdk.xdr.ScVal.scvSymbol(symbol),
    ]);
    const res = await simulate(REFLECTOR_FX, "lastprice", asset);
    if (!res.ok || !res.value || res.value.price === undefined) return null;
    const price = BigInt(res.value.price); // USD value of 1 local unit, scaled 10^dec
    if (price <= 0n) return null;
    // Staleness gate: don't present a frozen oracle price as a live rate. If the
    // feed hasn't updated in over an hour, return null so the caller falls back to
    // the HTTP FX API rather than mislabeling a stale number "live · on-chain".
    const ts = Number(res.value.timestamp);
    if (ts > 0 && Date.now() / 1000 - ts > 3600) return null;
    const scale = 10n ** BigInt(_fxDecimals);
    const rate = Number(scale) / Number(price); // local units per 1 USD
    // Plausibility bound: a dust/garbage price would make the reciprocal explode and
    // 1000x the off-ramp figure. No real fiat trades above ~1e7 per USD; reject out-of-band.
    if (!isFinite(rate) || rate <= 0 || rate > 1e7) return null;
    return { rate, timestamp: ts };
  } catch (_) {
    return null;
  }
}

/**
 * Off-ramp quote computed ON-CHAIN by the pool: it cross-contract-reads the
 * Reflector oracle and returns the local fiat for `usdcAmount` (whole USDC) at the
 * live rate. This is contract-to-contract composability — the receiver's revealed
 * figure is derived by our Soroban contract reading Reflector, not a client math.
 * Returns the local amount (Number) or null if the feed doesn't carry the symbol.
 */
export async function offrampQuote(symbol, usdcAmount) {
  const res = await simulate(
    POOL,
    "offramp_quote",
    Sdk.xdr.ScVal.scvSymbol(symbol),
    Sdk.nativeToScVal(BigInt(Math.max(0, Math.round(usdcAmount))), { type: "i128" }),
  );
  if (!res.ok || res.value == null) return null;
  const n = Number(res.value);
  return isFinite(n) && n >= 0 ? n : null;
}

/**
 * Manipulation-resistant off-ramp quote: priced at the MEDIAN of the last `records`
 * Reflector records — the exact basis the withdraw settlement gate enforces. Used to
 * compute the min-receive floor so the client's floor and the on-chain gate agree
 * (rather than deriving the floor from a spot price that could diverge from the median).
 * Returns the local amount (Number) or null if the feed is too thin / unavailable.
 */
export async function offrampQuoteTwap(symbol, usdcAmount, records = 5) {
  const res = await simulate(
    POOL,
    "offramp_quote_twap",
    Sdk.xdr.ScVal.scvSymbol(symbol),
    Sdk.nativeToScVal(BigInt(Math.max(0, Math.round(usdcAmount))), { type: "i128" }),
    Sdk.nativeToScVal(records, { type: "u32" }),
  );
  if (!res.ok || res.value == null) return null;
  const n = Number(res.value);
  return isFinite(n) && n >= 0 ? n : null;
}

/**
 * Read the pool's LIVE deny-list (the block-list "policy registry") so the compliance
 * proof's non-membership public inputs are built from the CURRENT on-chain policy —
 * honoring an admin `set_deny_list` without shipping a new frontend. Returns an array
 * of decimal field-element strings (each 32-byte BytesN read big-endian), or null on
 * any read failure (caller falls back to the witness snapshot).
 */
export async function readDenyList() {
  const res = await simulate(POOL, "deny_list");
  if (!res.ok || !Array.isArray(res.value)) return null;
  try {
    return res.value.map((b) => {
      const u = b instanceof Uint8Array ? b : Uint8Array.from(b);
      let n = 0n;
      for (const x of u) n = (n << 8n) | BigInt(x);
      return n.toString();
    });
  } catch { return null; }
}

/** Read the pool's live custody balance + commitment count from chain. */
export async function readPoolState() {
  const [bal, count] = await Promise.all([
    simulate(POOL, "balance"),
    simulate(POOL, "commitment_count"),
  ]);
  return {
    balance: bal.ok ? bal.value.toString() : "?",
    commitments: count.ok ? count.value.toString() : "?",
  };
}

/**
 * Recent corridor activity from on-chain events via RPC getEvents — the indexing
 * tier. The pool emits deposit/withdraw/transfer/root events; this reads them back so
 * the console can show a live feed sourced from chain, not local state. Privacy scope:
 * deposit/withdraw are the public on/off-ramp edges (real USDC + amount move to/from a
 * public address there); the SHIELDED middle transfer leg is what's hidden. The event
 * feed does NOT label which deposit a withdrawal came from, but equal amounts at both
 * edges remain statistically correlatable — link-privacy = the anonymity set (see
 * docs/SECURITY.md "Privacy model"). NOTE: testnet public RPC ages events
 * out (~latest-10k ledgers), so this is a RECENT view, not a source of truth — the
 * spendable tree is reconstructed from DURABLE state (loadLeavesFromChain), which has
 * no retention dependency. Returns [] on any error (feed is best-effort).
 */
export async function readRecentActivity(maxEvents = 10) {
  try {
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - 9000); // ~half a day at ~5s/ledger
    const res = await server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [POOL] }],
      limit: 100,
    });
    const toNative = (x) => {
      try {
        const sc = typeof x === "string" ? Sdk.xdr.ScVal.fromXDR(x, "base64") : x;
        return Sdk.scValToNative(sc);
      } catch (_) { return null; }
    };
    return (res.events || []).map((ev) => ({
      kind: String((ev.topic && ev.topic[0] != null ? toNative(ev.topic[0]) : "?")), // deposit|withdraw|transfer|root
      ledger: ev.ledger,
      txHash: ev.txHash,
    })).slice(-maxEvents).reverse(); // newest first
  } catch (_) {
    return [];
  }
}

const bytesToBig = (u8) => { let x = 0n; for (const b of u8) x = (x << 8n) | BigInt(b); return x; };

/** The pool's current Merkle root, as a BigInt (or null on error). */
export async function readCurrentRoot() {
  const r = await simulate(POOL, "current_root");
  if (!r.ok || !r.value) return null;
  try { return bytesToBig(r.value); } catch (_) { return null; }
}
/**
 * The ordered Merkle-tree leaves (deposited commitments), read from the pool's
 * DURABLE on-chain state via `leaves()`. Unlike event reconstruction this does
 * NOT depend on RPC event retention, so the browser tree always mirrors the real
 * on-chain tree — reload-safe and correct even when other users have deposited.
 * Returns BigInt[] in tree order (or [] on error).
 */
export async function loadLeavesFromChain() {
  const cnt = await simulate(POOL, "leaf_count");
  if (!cnt.ok) return [];
  const n = Number(cnt.value);
  const out = [];
  const CHUNK = 64; // paginate so this scales past a single read budget
  const u32 = (x) => Sdk.nativeToScVal(x, { type: "u32" });
  for (let start = 0; start < n; start += CHUNK) {
    const r = await simulate(POOL, "leaf_range", u32(start), u32(CHUNK));
    if (!r.ok || !Array.isArray(r.value)) return [];
    for (const b of r.value) out.push(bytesToBig(b));
  }
  return out;
}

// snarkjs proof -> contract args (G2 uses Soroban c1||c0 ordering).
const fe = (d) => BigInt(d).toString(16).padStart(64, "0");
const g1 = (pt) => fe(pt[0]) + fe(pt[1]);
const g2 = (pt) => fe(pt[0][1]) + fe(pt[0][0]) + fe(pt[1][1]) + fe(pt[1][0]);
const buf = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

/**
 * Verify a disclosure proof ON-CHAIN by simulating the deployed verifier's
 * `verify(proof, public_inputs)`. Returns { verified, error }.
 */
let _client;
async function disclosureClient() {
  if (!_client) {
    _client = await Sdk.contract.Client.from({
      contractId: DISCLOSURE_VERIFIER,
      networkPassphrase: PASSPHRASE,
      rpcUrl: RPC,
    });
  }
  return _client;
}

export async function verifyDisclosureOnChain(proof, publicSignals) {
  try {
    const client = await disclosureClient();
    const at = await client.verify({
      proof: { a: buf(g1(proof.pi_a)), b: buf(g2(proof.pi_b)), c: buf(g1(proof.pi_c)) },
      public_inputs: publicSignals.map((s) => BigInt(s)),
    });
    // read-only: at.result is the parsed return value (Result<bool,_> -> {value:true})
    const r = at.result;
    const ok = r === true || r?.value === true || r?.tag === "Ok";
    if (ok) return { verified: true };
    return { verified: false, error: "verifier returned false" };
  } catch (e) {
    // an invalid proof traps -> simulation throws; that's a (correct) rejection
    return { verified: false, error: (e && e.message) || String(e) };
  }
}

const buf32 = (dec) => buf(BigInt(dec).toString(16).padStart(64, "0"));

let _asp;
async function aspWitness() {
  if (!_asp) _asp = await (await fetch("./circuit/asp-witness.json")).json();
  return _asp;
}

// Optional external wallet (Freighter). When set, deposits/withdraws are signed
// by the user's own wallet instead of the embedded demo key. Falls back to the
// demo key when null, so the no-install demo always works.
let _wallet = null; // { address, signTransaction, signAuthEntry }
export function setWalletSigner(w) { _wallet = w; _poolWrite = null; }
export function activeAddress() { return _wallet ? _wallet.address : DEMO_ADDRESS; }
export function usingWallet() { return !!_wallet; }

// ---- SEP anchor on-ramp (REAL, no mock) ----
// Fund the active account with USDC through a real Stellar anchor: discover it
// (SEP-1), authenticate the active account (SEP-10 — the challenge is signed by the
// connected Freighter wallet, or the built-in demo key), then open a genuine
// interactive USDC deposit session (SEP-24) hosted by the anchor. Returns
// { url, id, asset, address }. Uses SDF's public REFERENCE anchor on testnet (no KYC);
// a production deploy would point ANCHOR at a licensed anchor issuing the corridor's
// asset — that last mile is a partner + KYC, not code.
const ANCHOR = "https://testanchor.stellar.org";
export async function anchorOnramp() {
  const address = activeAddress();
  const toml = await (await fetch(`${ANCHOR}/.well-known/stellar.toml`)).text();
  const grab = (k) => (toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, "m")) || [])[1];
  const WEB_AUTH = grab("WEB_AUTH_ENDPOINT"), SEP24 = grab("TRANSFER_SERVER_SEP0024");
  if (!WEB_AUTH || !SEP24) throw new Error("anchor stellar.toml is missing endpoints");
  // SEP-10: fetch the challenge tx, add our signature, exchange it for a JWT.
  const chal = await (await fetch(`${WEB_AUTH}?account=${address}&home_domain=testanchor.stellar.org`)).json();
  if (!chal.transaction) throw new Error("SEP-10 challenge failed: " + (chal.error || "no transaction"));
  const netPass = chal.network_passphrase || PASSPHRASE;
  let signedXdr;
  if (_wallet && _wallet.signTransaction) {
    const res = await _wallet.signTransaction(chal.transaction, { networkPassphrase: netPass, address });
    signedXdr = res.signedTxXdr || res;
  } else {
    const tx = new Sdk.Transaction(chal.transaction, netPass);
    tx.sign(Sdk.Keypair.fromSecret(DEMO_SECRET));
    signedXdr = tx.toXDR();
  }
  const jwtRes = await (await fetch(WEB_AUTH, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction: signedXdr }),
  })).json();
  if (!jwtRes.token) throw new Error("SEP-10 auth failed: " + (jwtRes.error || "no token"));
  const bearer = { Authorization: `Bearer ${jwtRes.token}` };
  // SEP-24: pick USDC (fallback to whatever the anchor supports) and open the session.
  const info = await (await fetch(`${SEP24}/info`, { headers: bearer })).json();
  const assets = Object.keys(info.deposit || {});
  const asset = assets.includes("USDC") ? "USDC" : (assets[0] || "USDC");
  const intr = await (await fetch(`${SEP24}/transactions/deposit/interactive`, {
    method: "POST", headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ asset_code: asset, account: address }),
  })).json();
  if (!intr.url) throw new Error("SEP-24 interactive deposit failed: " + (intr.error || "no url"));
  return { url: intr.url, id: intr.id, asset, address };
}

let _poolWrite;
async function poolWriteClient() {
  if (!_poolWrite) {
    if (_wallet) {
      _poolWrite = await Sdk.contract.Client.from({
        contractId: POOL,
        networkPassphrase: PASSPHRASE,
        rpcUrl: RPC,
        publicKey: _wallet.address,
        signTransaction: _wallet.signTransaction,
        signAuthEntry: _wallet.signAuthEntry,
      });
      _poolWrite._from = _wallet.address;
    } else {
      const kp = Sdk.Keypair.fromSecret(DEMO_SECRET);
      const signer = Sdk.contract.basicNodeSigner(kp, PASSPHRASE);
      _poolWrite = await Sdk.contract.Client.from({
        contractId: POOL,
        networkPassphrase: PASSPHRASE,
        rpcUrl: RPC,
        publicKey: kp.publicKey(),
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      });
      _poolWrite._from = kp.publicKey();
    }
  }
  return _poolWrite;
}

// signAndSend with a rebuild-and-retry on TRANSIENT faults. `buildAt` rebuilds the
// AssembledTransaction, which re-simulates and refetches the source sequence, so a
// retry self-heals both a sequence race on the shared embedded demo key (deposit→
// register→withdraw fired back-to-back, or multiple tabs) AND the load-shedding the
// public testnet throws under contention: TRY_AGAIN_LATER, timeouts, txTooLate,
// 429/5xx. A contract revert (Error(Contract,#N)) is DETERMINISTIC — never retried,
// so a genuine double-spend (#2) or slippage block (#12) surfaces immediately.
// ponytail: bounded to 5 tries; a real per-user wallet rarely needs more than one.
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _msg = (e) => String(e?.message ?? e ?? "");
const _isContractRevert = (e) => /Error\(Contract,\s*#\d+\)/.test(_msg(e));
const _isTransient = (e) => !_isContractRevert(e) &&
  /txbadseq|tx_bad_seq|bad_seq|try_again_later|timed?\s?out|timeout|txtoolate|\b(?:429|50\d)\b|failed to (?:send|submit)|network|fetch/i.test(_msg(e));
async function sendTx(buildAt, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const at = await buildAt();
      return await at.signAndSend();
    } catch (e) {
      lastErr = e;
      if (i < attempts && _isTransient(e)) { await _sleep(1200 + i * 900); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// ---- testnet wallet setup helpers (for the optional Freighter path) ----
const USDC = new Sdk.Asset("USDC", "GC7SWGHRQLMP4SW2AOBRSC2HFKVPNPHBH5A3PX3ZDVEJFMYKLWQ3SY3B");

async function submitClassic(tx) {
  const sent = await server.sendTransaction(tx);
  let status = sent.status, hash = sent.hash;
  for (let i = 0; i < 15 && (status === "PENDING" || status === "NOT_FOUND" || status === "TRY_AGAIN_LATER"); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const g = await server.getTransaction(hash); status = g.status; } catch (_) {}
  }
  if (status !== "SUCCESS") throw new Error("tx " + status);
  return hash;
}

/** Fund a testnet account with XLM via friendbot (no-op if already funded). */
export async function friendbotFund(address) {
  try {
    await server.getAccount(address);
    return { ok: true, already: true };
  } catch (_) {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
    return { ok: r.ok };
  }
}

/** Add a USDC trustline to `address`, signed by the connected wallet. */
export async function addUsdcTrustline(address, signTransaction) {
  const acct = await server.getAccount(address);
  const tx = new Sdk.TransactionBuilder(acct, { fee: Sdk.BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Sdk.Operation.changeTrust({ asset: USDC }))
    .setTimeout(120)
    .build();
  const { signedTxXdr } = await signTransaction(tx.toXDR(), { networkPassphrase: PASSPHRASE, address });
  const signed = Sdk.TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE);
  return submitClassic(signed);
}

/** Faucet: the demo key sends `amount` USDC to `address` (needs a trustline). */
export async function faucetUsdc(address, amount = "5000") {
  const kp = Sdk.Keypair.fromSecret(DEMO_SECRET);
  const acct = await server.getAccount(kp.publicKey());
  const tx = new Sdk.TransactionBuilder(acct, { fee: Sdk.BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Sdk.Operation.payment({ destination: address, asset: USDC, amount }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return submitClassic(tx);
}

/**
 * Real on-chain deposit: builds a compliance proof in the browser (the source is
 * a member of the pinned ASP allow-list, bound to this commitment), then signs
 * and submits pool.deposit. The pool's commitment count goes up and tokens move.
 * Returns { ok, hash } or { ok:false, error }.
 */
const scProof = (p) => ({ a: buf(g1(p.pi_a)), b: buf(g2(p.pi_b)), c: buf(g1(p.pi_c)) });

export async function depositOnChain(note, opts = {}) {
  try {
    const asp = await aspWitness();
    // 1. compliance proof: prove the AUTHENTICATED depositor (field(from)) is an
    // allow-listed source, bound to this commitment. sourceKey is now a PUBLIC input
    // the contract pins to field(from), so the proof authenticates this depositor.
    const src = addrField(activeAddress());
    const members = asp.members || [];
    let m = members.find((x) => x.sourceKey === src);
    if (opts.forgeSource) {
      // Demonstrate the auth: build a VALID proof for a DIFFERENT approved source
      // than field(from). The contract pins sourceKey = field(from), so the public
      // input won't match the proof -> the ASP rejects it ON-CHAIN (InvalidProof).
      m = members.find((x) => x.sourceKey !== src) || members[1] || members[0];
    } else if (!m) {
      return { ok: false, error: "this account is not an approved ASP source (only allow-listed keys can deposit)" };
    }
    // Build the deny-list public inputs from the LIVE on-chain policy so an admin
    // set_deny_list is honored without a frontend redeploy; fall back to the witness
    // snapshot if the read fails. (aspRoot membership uses the witness tree; the
    // deny-list only feeds the circuit's 4 non-membership checks, so swapping it here
    // never touches the membership path.)
    const liveDeny = await readDenyList();
    const denyList = (liveDeny && liveDeny.length === asp.denyList.length) ? liveDeny : asp.denyList;
    const compInput = {
      aspRoot: asp.aspRoot, denyList, bindHash: note.commitment,
      sourceKey: m.sourceKey, pathElements: m.pathElements, leafIndex: m.leafIndex,
    };
    const { proof: compProof } = await snarkjs.groth16.fullProve(
      compInput, "./circuit/compliance.wasm", "./circuit/compliance_final.zkey",
    );
    // 2. binding proof (disclosure): commitment opens to exactly `amount`, ctx=7
    const bindInput = {
      commitment: note.commitment, disclosedAmount: note.amount, auditContextHash: "7",
      amount: note.amount, pubKey: note.pubKey, blinding: note.blinding,
    };
    const { proof: bindProof } = await snarkjs.groth16.fullProve(
      bindInput, "./circuit/disclosure.wasm", "./circuit/disclosure_final.zkey",
    );
    // 3. signed deposit moving the REAL token amount
    const client = await poolWriteClient();
    const res = await sendTx(() => client.deposit({
      from: client._from,
      amount: BigInt(note.amount),
      commitment: buf32(note.commitment),
      proof: scProof(compProof),
      binding_proof: scProof(bindProof),
    }));
    const hash = res?.sendTransactionResponse?.hash || res?.getTransactionResponse?.txHash || "";
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, error: friendlyPoolError(e) };
  }
}

/**
 * Trustlessly advance the pool's Merkle root: prove (merkleUpdate) that inserting
 * newLeaf into the known oldRoot yields newRoot, then submit register_root_verified.
 * Makes the just-deposited commitment part of an on-chain registered tree.
 */
export async function registerRootOnChain(oldRootDec, newLeafDec, newRootDec, leafIndex, pathElementsDec) {
  try {
    const input = {
      oldRoot: oldRootDec, newLeaf: newLeafDec, newRoot: newRootDec,
      leafIndex: String(leafIndex), pathElements: pathElementsDec,
    };
    const { proof } = await snarkjs.groth16.fullProve(
      // ?v bumped when the circuit changes (leafIndex is now a public input) so a
      // returning visitor never proves with a stale circuit the verifier rejects.
      input, "./circuit/merkleUpdate.wasm?v=2", "./circuit/merkleUpdate_final.zkey?v=2",
    );
    const client = await poolWriteClient();
    const res = await sendTx(() => client.register_root_verified({
      proof: { a: buf(g1(proof.pi_a)), b: buf(g2(proof.pi_b)), c: buf(g1(proof.pi_c)) },
      old_root: buf32(oldRootDec),
      new_leaf: buf32(newLeafDec),
      new_root: buf32(newRootDec),
    }));
    return { ok: true, hash: res?.sendTransactionResponse?.hash || "" };
  } catch (e) {
    return { ok: false, error: friendlyPoolError(e), code: poolErrorCode(e) };
  }
}

export const DEMO_ADDRESS = Sdk.Keypair.fromSecret(DEMO_SECRET).publicKey();

/**
 * The withdraw ext-data hash binding the recipient: keccak256(recipient XDR ||
 * public_amount) reduced mod r. Must match the contract's `ext_data_hash` recompute
 * exactly — the transfer proof is generated with this value, so it commits to the
 * recipient and can't be replayed elsewhere. `publicAmountDec` is the field-negative
 * (r - amount) decimal string.
 */
export function extDataHashFor(recipient, publicAmountDec) {
  const xdr = Sdk.nativeToScVal(recipient, { type: "address" }).toXDR(); // Uint8Array (ScVal::Address)
  const amt = buf32(publicAmountDec); // 32 bytes, big-endian
  const data = new Uint8Array(xdr.length + amt.length);
  data.set(xdr, 0);
  data.set(amt, xdr.length);
  const hex = keccak256(data); // 64-char hex (no 0x)
  return (BigInt("0x" + hex) % FIELD_R).toString();
}

/**
 * field(addr) = keccak256(addr ScVal XDR) mod r — the ASP allow-list key for an
 * account. Must match the contract's `addr_field(from)` exactly, so the compliance
 * proof's public sourceKey is pinned to the authenticated depositor.
 */
export function addrField(address) {
  const xdr = Sdk.nativeToScVal(address, { type: "address" }).toXDR();
  return (BigInt("0x" + keccak256(xdr)) % FIELD_R).toString();
}

/**
 * Submit a signed pool.withdraw given a transfer proof + its public signals.
 * Spends the note's nullifier on-chain and releases `releaseAmount` tokens. The
 * proof's public_amount is the field-negative (r - releaseAmount): value leaving.
 */
// Map the pool contract's PoolError codes (lib.rs) to human messages. A raw
// SDK error reads like "...Error(Contract, #2)"; we surface what actually failed.
const POOL_ERRORS = {
  1: "this root isn't recognized on-chain (the tree moved on — re-sync and retry)",
  2: "this note was already spent — its nullifier is used (double-spend rejected on-chain)",
  3: "unknown commitment — this note isn't in the pool",
  4: "the deny-list check failed on-chain",
  5: "invalid amount",
  6: "the amount isn't bound to the commitment (binding proof missing)",
  7: "the zero-knowledge proof was rejected by the on-chain verifier",
  8: "the corridor tree is full",
  9: "this leaf isn't a backed deposit, or was already inserted (unbacked-leaf insert rejected)",
  10: "this commitment was already deposited (duplicate deposit rejected — it would lock funds)",
  11: "the FX oracle has no live price for this currency (off-ramp quote unavailable)",
  12: "the live FX rate would deliver less than your minimum (slippage too high — release blocked, note unspent)",
};
function friendlyPoolError(e) {
  const msg = (e && e.message) || String(e);
  // The token contract's own errors (e.g. insufficient balance) also surface as
  // "Error(Contract, #N)" and can collide with a PoolError of the same number (both
  // are small enums numbered from their own contract's error type) — that numeric
  // match alone can't tell which contract actually trapped. Check for the token
  // contract's known diagnostic wording FIRST so a plain low-balance deposit doesn't
  // get mislabeled with an unrelated PoolError message (e.g. "duplicate deposit").
  if (/resulting balance is not within the allowed range/i.test(msg)) {
    return "insufficient USDC balance for this deposit (fund the account and retry)";
  }
  const m = msg.match(/Error\(Contract,\s*#(\d+)\)/);
  if (m && POOL_ERRORS[Number(m[1])]) return POOL_ERRORS[Number(m[1])];
  return msg;
}
// The numeric PoolError code (or null). Callers branch on this instead of
// pattern-matching the friendly string (which no longer contains "#N").
function poolErrorCode(e) {
  const m = ((e && e.message) || String(e)).match(/Error\(Contract,\s*#(\d+)\)/);
  return m ? Number(m[1]) : null;
}

export async function withdrawSubmit(proof, publicSignals, recipientPub, releaseAmount, offrampSymbol, minLocalOut) {
  try {
    const [root, publicAmount, , n0, n1, oc0, oc1] = publicSignals;
    const client = await poolWriteClient();
    // No ext_data_hash arg: the contract recomputes it from (recipient, public_amount)
    // and binds the proof to the recipient — so a replayed proof can't be redirected.
    // offramp_symbol + min_local_out are the OPTIONAL min-receive settlement gate: when
    // set, the pool reads Reflector on-chain and refuses to release if the live local
    // amount is below the floor (SlippageExceeded). undefined -> None (no gate).
    const res = await sendTx(() => client.withdraw({
      proof: { a: buf(g1(proof.pi_a)), b: buf(g2(proof.pi_b)), c: buf(g1(proof.pi_c)) },
      root: buf32(root),
      public_amount: buf32(publicAmount), // field-negative (r - amount): value leaving
      nullifiers: [buf32(n0), buf32(n1)],
      out_commitments: [buf32(oc0), buf32(oc1)],
      recipient: recipientPub || DEMO_ADDRESS,
      amount: BigInt(releaseAmount), // magnitude released; pool binds it to (r - amount)
      offramp_symbol: offrampSymbol || undefined,
      min_local_out: (minLocalOut != null) ? BigInt(Math.floor(minLocalOut)) : undefined,
    }));
    return { ok: true, hash: res?.sendTransactionResponse?.hash || "" };
  } catch (e) {
    return { ok: false, error: friendlyPoolError(e), code: poolErrorCode(e) };
  }
}

export const txExplorer = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
export const explorer = (id) => `https://stellar.expert/explorer/testnet/contract/${id}`;
