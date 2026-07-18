# Tukar — QA & Testing

A full QA pass covering repo hygiene, circuit soundness, contract unit tests, and
on-chain behaviour (positive + negative) on Stellar testnet.

## Test matrix — every suite, last full run (all green)

| Type | Suite | Command | Result |
|---|---|---|---|
| **Unit** — contract | pool (Rust) | `cargo test` | **36/36** |
| **Unit** — frontend | client Merkle tree | `npm run test:unit` | **15/15** |
| **Unit** — circuit soundness | negative (transfer + compliance) | `npm run test:negative` | **6/6** |
| **Proving** | valid / tampered / false-witness | `npm run test:proving` | pass |
| **Trusted setup** | zkey ⇐ Hermez ptau | `snarkjs zkey verify` ×4 | **4/4 ZKey Ok** |
| **Integration** — routing | per-page nav + no-flash + reload | `npm run test:pages` | **10/10** |
| **Integration** — receiver UI | withdrawn-note auto-hide + off-ramp to another corridor | `npm run test:offramp` | **9/9** |
| **Integration** — full flow | deposit→reveal→withdraw→disclose→tamper | `npm run test:e2e` | **11/11** |
| **Integration** — bearer P2P | export→wipe→import→withdraw | `npm run test:bearer` | **4/4** |
| **Integration** — QR | decode bearer + request QR | `npm run test:qr` | **2/2** |
| **Integration** — landing | links/CTA/no-errors | `npm run test:landing` | **5/5** |
| **Integration** — anchor UI | in-UI SEP-10+24 on-ramp | `npm run test:anchor` | **5/5** |
| **Integration** — anchor SEPs | SEP-1/10/6/24/31 | `npm run sep:anchor` | **5/5** |

Every suite in the matrix is green. Regression pass: all of the above were re-run
together after each change.
The deterministic suites (unit, proving, soundness) are safe to wire into any CI
system; the live Playwright suites are manual pre-deploy gates (they need a funded
testnet key + a running/deployed site).

## How to run the test suite

```bash
npm run circuit:all      # compile + prove + verify all 4 circuits (Groth16/BN254)
npm run test:proving     # in-browser proving flow: valid / tampered / false-witness
npm run test:negative    # circuit soundness: transfer + compliance violations rejected
npm run test:e2e         # Playwright real-click e2e (drives the live site, real clicks)
# contract unit tests (in WSL/Linux):
cd contracts/pool && cargo test          # 36/36
```

> `npm run circuit:all` fetches the **real Hermez** phase-1 ptau
> (`powersOfTau28_hez_final_14.ptau`, ~19 MB) on first run and asserts each rebuilt
> zkey derives from it (`snarkjs zkey verify`) — so the build is reproducibly
> waste-free, not generated from a local phase-1. See §5.

## 1. Repo hygiene ✅
- No secrets, `.ptau`, `.wtns`, tool binaries, or `node_modules` tracked.
- Only the demo artifacts (`frontend/circuit/disclosure.wasm`, `.zkey`, vk) are
  committed (needed to serve the browser demo). Largest tracked file 1.8 MB.
- Contract IDs are consistent across README, the frontend, these docs, and
  `deployments/testnet.json` (current pool `CABRLZH…AA7FEXPJ`; older deployments are
  recorded under `deployments/testnet.json` → `pool.supersedes`).
- `LICENSE` (Apache-2.0) present; `test_snapshots/` ignored.

## 2. Circuit soundness ✅

| Circuit | Positive | Negative (must reject) |
|---|---|---|
| disclosure | valid proof verifies | false witness rejected; tampered claim → verify false |
| transfer | valid proof verifies | broken value conservation rejected; forged nullifier rejected |
| compliance | valid proof verifies | source on deny-list rejected; non-member (wrong ASP root) rejected |

`npm run test:negative` → **6/6 passed**. `npm run test:proving` → valid/tampered/
false-witness all behave correctly.

**Manual circuit review (2026-06-30)** — complements the runtime negative tests by
checking the Circom source for under-constrained signals (the soundness holes a
passing happy-path can't reveal):
- **Every private signal is constrained.** In `transfer`, `compliance`, `disclosure`
  and `merkleUpdate`, each `signal input` feeds a `===`/`<==` constraint (Poseidon
  preimage, Merkle path, nullifier, or range) — no `<--` left dangling.
- **All amounts are range-checked:** transfer inputs **and** outputs to 248 bits
  (wrap-free value conservation, not just an inductive invariant); disclosure amount
  to 64 bits.
- **Path indices are boolean-forced** in `DualMux` (`s*(1-s)===0`), so a malformed
  Merkle witness can't bend the path even if a caller skips `Num2Bits`.
- **`merkleUpdate` proves the slot is empty** (leaf=0 must reproduce the public
  `oldRoot`) and that the same private siblings yield `newRoot` — siblings can't be
  faked (Poseidon CR + public `oldRoot`).
- **Dummy JoinSplit inputs are sound:** zero-value inputs skip Merkle membership
  (`(root-r)*inAmount===0`) but still bind a nullifier; the frontend draws the
  dummy's `privKey`/`blinding` from a CSPRNG per spend, so dummy nullifiers never
  collide across withdraws. No `NullifierUsed` trap, no value mint.

Result: no under-constrained signal or missing range check found.

## 3. Contract unit tests ✅
`contracts/pool` — **36/36 passed** (`cargo test`): deposit pulls USDC + records
commitment; withdraw releases the bound amount; mismatched-amount withdraw
rejected (`AmountNotBound`); transfer spends nullifiers + records outputs;
**double-spend replay rejected** (`NullifierUsed`); **unknown root rejected**
(`UnknownRoot`); disclose requires a known commitment; unknown-commitment disclose
rejected (`UnknownCommitment`); `register_root_verified` advances from the current
root and rejects an unknown or **stale** one (accumulator semantics); leaves are
**stored on-chain in order** (`leaves()`/`leaf_count`); **`poseidon_matches_circomlib`**
(on-chain Poseidon == circomlibjs `poseidon([1,2])`); and a `poseidon_cost_probe`
diagnostic. The admin `register_root` backdoor was removed, so the only way to
advance the root is a
`merkleUpdate` proof. The leaf inserted by `register_root_verified` must be a
commitment already recorded by a real `deposit` (or change-note output) and may be
inserted at most once — `register_root_verified_rejects_undeposited_leaf`
(`UnknownCommitment`) and `register_root_verified_rejects_double_insert`
(`LeafAlreadyInserted`) cover the **unbacked-leaf drain** defense. The merkleUpdate
`leafIndex` is now a **public** input the pool pins to its own `LeafCount`, so a
proof can't attest insertion at a different slot than the one stored (closes the
accumulator-griefing DoS). And `deposit_rejects_duplicate_commitment`
(`DuplicateCommitment`) covers the duplicate-deposit fund-lock fix. The I/O-count
pinning that closes the unpinned-split double-spend (T17) is covered by
`transfer_rejects_shifted_io_split` / `withdraw_rejects_shifted_io_split`
(`BadIoCount`).

> **What these unit tests do and don't cover.** `cargo test` runs against a **mock
> verifier that returns `true`** (`test.rs`), so it validates the pool's *binding,
> authorization, state-machine and oracle-gate logic* — not Groth16 soundness itself.
> Real proof verification (valid → `true`, tampered/false-witness → rejected) is
> covered separately by `npm run test:negative` (circuit soundness, §2) and by the
> **live on-chain** results against the deployed Nethermind BN254 verifiers (§4).
> The two layers together cover the system end-to-end; neither alone does.

## 4. On-chain behaviour (Stellar testnet) ✅

Positive — all return `true`:

| Call | Contract | Result |
|---|---|---|
| `disclosure.verify` | `CACVDX…AOD3` | `true` |
| `transfer.verify` | `CCRCRVF…I6K3N` | `true` |
| `compliance.verify` | `CAGBZGF…XIJQO` | `true` |
| `pool.deposit` | `CABRLZH…AA7FEXPJ` | success — moved real USDC in, bound to the commitment |
| `pool.withdraw` | `CABRLZH…AA7FEXPJ` | success — released USDC, amount bound to negative `public_amount` |
| `pool.register_root_verified` | `CABRLZH…AA7FEXPJ` | success — trustless root advance (merkleUpdate proof) |
| `pool.poseidon_hash(1,2)` | `CABRLZH…AA7FEXPJ` | `0x115cc0f5…4417189a` — circomlib-exact Poseidon on-chain |
| `merkleUpdate.verify` | `CBQB4AJ…7EP5Z` | `true` |

Negative — all correctly rejected:

| Scenario | Expected error | Result |
|---|---|---|
| `disclosure.verify` / `transfer.verify` tampered public input | `InvalidProof` (#0) | rejected ✅ |
| **`pool.transfer` valid proof but TAMPERED nullifiers (double-spend bypass)** | `InvalidProof` (#0) | **rejected ✅** |
| `pool.transfer` replay (double-spend) | `NullifierUsed` (#2) | rejected ✅ |
| `pool.transfer` with unknown root | `UnknownRoot` (#1) | rejected ✅ |
| `pool.withdraw` amount ≠ proof public_amount | `AmountNotBound` (#6) | rejected ✅ |
| **`register_root_verified` with a FAKE new_root** | `InvalidProof` (#0) | **rejected ✅** |
| `pool.disclose` of unknown commitment | `UnknownCommitment` (#3) | rejected ✅ (unit) |

The **double-spend-bypass** row is the important one: because the pool builds the
verifier's public inputs from the typed nullifiers/commitments/root itself, a
caller cannot present a valid proof while spending different nullifiers — the
verification fails. This closes the binding gap found in QA.

State checks after the test transfer: `pool.current_root` = registered root,
`commitment_count` = 2, `is_root_known(root)` = true, `is_nullifier_used(spent)` = true.

## 5. Trusted setup — independently verifiable ✅

All four **deployed** proving keys (`frontend/circuit/*_final.zkey`) derive from the
real **Hermez** perpetual Powers-of-Tau ceremony (`powersOfTau28_hez_final_14.ptau`),
so phase-1 has **no locally-known toxic waste**. This is not a claim to take on
faith — anyone can check it:

```bash
# for each circuit c in {disclosure, compliance, merkleUpdate, transfer}:
snarkjs zkey verify circuits/build/$c.r1cs circuits/build/pot14_hez.ptau \
        frontend/circuit/${c}_final.zkey      # => "ZKey Ok!"
```

Verified 2026-06-30: **ZKey Ok! for all four** (2^14 = 16384 ≥ transfer's 15884
constraints). The build scripts (`build-circuit.sh`, `build-disclosure.sh`) fetch
this exact ptau and run the same assertion, so a stale local-ptau key can never
silently replace a deployed one. Honest caveat: **phase-2** is a single Tukar
contribution (a production deploy wants a multi-party phase-2 too).

## 6. End-to-end UI (Playwright real-click) ✅ 11/11 live

`npm run test:e2e` drives the site (a local `npm run serve`, or a deployed copy) with
genuine clicks/typing/selects (not `evaluate`-injection) over
system Chrome. Eleven cases: prover-load, Send-gating pre-connect, payment-request
round-trip, connect, invalid-amount fuzzing (no crash), **junk typed into Load/Import
handled gracefully** (no crash — covers a real user mistyping into those boxes), all 7
corridors (3 on-chain Reflector / 4 FX-API), the full happy path (deposit → reveal →
withdraw → disclose → tamper), on-chain ASP forge-rejection (and that the forge toggle
**auto-clears** after the rejection, so a real send isn't trapped re-forging),
bearer-note P2P + **cross-wallet double-spend**, and disconnect re-gating.

Verified 2026-07-03: **11/11**, zero uncaught page errors — including both heavy
on-chain flows (happy path + ASP forge-rejection) and the double-spend case. Two
fixes closed the last gap:

- **Product:** the shared submit path (`stellar.js` `sendTx`) now rebuilds-and-retries
  on *transient* testnet faults — sequence races on the shared demo key, plus the
  load-shedding the public testnet throws (`TRY_AGAIN_LATER`, timeouts, 429/5xx). A
  contract revert (`Error(Contract,#N)`) is deterministic and is **never** retried, so
  a genuine double-spend `#2` or slippage block `#12` still surfaces at once. Real users
  on a flaky testnet benefit from this too, not just the harness.
- **Test:** the double-spend case now models the *real* threat — a **second holder** of
  the same bearer string on a different device. Re-importing into the wallet that
  already holds the note is (correctly) refused as a duplicate, so the case resets the
  session first (simulating the other device), re-imports, and attempts the withdraw —
  the on-chain `NullifierUsed` (`#2`) rejects it. This exercises the on-chain
  double-spend protection through the UI, matching the unit test
  `transfer_double_spend_rejected` and the on-chain result in §4.

## 7. QR codes actually scan ✅ 2/2 live

`npm run test:qr` proves the bearer-note and payment-request QR codes the demo
renders decode back to the **exact** string a phone camera would read — important
because Tukar styles them with custom colors (dark `#0a0705` on `#f3ad79`), not
plain black-on-white. The test loads the live demo, generates each QR, then decodes
the rendered PNG with **jsQR** over its raw pixels (the same algorithm a scanner
uses) and asserts `decoded === the visible string`.

Verified 2026-06-30 against the live deploy: **2/2** — `tukreq1:…` (payment request)
and `tukar1:…` (bearer note, after a real on-chain deposit) both decode exactly,
zero uncaught page errors. So the custom-styled QR remains camera-scannable.

## 8. Bearer note is real spendable money ✅ 4/4 live

`npm run test:bearer` proves the `tukar1:…` string a QR encodes isn't just display —
it's withdrawable value on a device that has nothing but the string. Steps, on the
live deploy: (1) deposit a note on-chain, (2) export the bearer string, (3) **wipe
the local session** and import the bare string as a fresh holder (the pool
reconstructs the tree from chain), (4) withdraw it — real tokens released on-chain.

Verified 2026-06-30: **4/4**, zero uncaught page errors. This isolates the genuine
P2P-handoff feature from the e2e's *cross-wallet double-spend* step (§6 case 9); both
now pass — the transient-retry fix in `sendTx` removed the shared-key contention that
used to make the back-to-back on-chain step flake.

## 9. Landing page QA (Playwright real-click) ✅ 5/5 live

`npm run test:landing` checks the page a judge sees first: H1 value-prop, **every**
`stellar.expert` contract link points to a LIVE contract id (not a superseded one),
footer links **deep-link** to the named doc/circuit (`/blob/main/docs/*.md`,
`/blob/main/circuits/*.circom`) rather than the bare repo root, zero console
errors / failed requests on load + scroll, and the primary CTA **real-click** lands
in a working demo (prover reaches Ready).

Verified 2026-06-30 on the live deploy: **5/5**, zero uncaught page errors. (Fixed
this round: the footer links previously all pointed at the repo root, so "Architecture"
didn't open ARCHITECTURE.md; now they deep-link.)

## 10. Per-page routing (Playwright) ✅ 8/8 live

The demo console is one corridor step per URL — `/demo/send`, `/demo/corridor`,
`/demo/receive`, `/demo/audit`. `npm run test:pages` asserts: loading `/demo` shows
only the Sender panel; the flow-strip and Back/Next pager navigate (pushState, URL
updates, only the active panel visible); the browser Back button works (popstate);
and a **direct load** of a deep route (e.g. `/demo/audit`) renders the right panel —
which requires the SPA rewrite (`serve.mjs` locally, or an equivalent rewrite rule
on whatever host serves this in production, map `/demo/<slug>` → the
console) **and** `<base href="/">` so relative assets resolve from root on a deep
path (a 404 the routing test caught before ship). Verified 8/8 on a live deploy;
client state (notes, demo-key connection) persists across steps via localStorage, so
a refresh or shared step link rehydrates.

## 11. Anchor SEP integration (real, live) ✅

The fiat-edge anchor protocols are integrated against SDF's public **reference**
anchor (`testanchor.stellar.org`), no mocks:

- `npm run sep:anchor` (`scripts/sep-anchor.mjs`) — **5/5 live**: SEP-1 discovery →
  SEP-10 (sign the challenge → real JWT) → SEP-6 `/info` → SEP-24 interactive deposit
  (a real hosted USDC on-ramp URL) → SEP-31 `/info`.
- `npm run test:anchor` (`scripts/test-anchor.mjs`) — **5/5 live**, a real Playwright
  click of the demo's **"Try a real anchor USDC on-ramp"** button: it authenticates
  (SEP-10, signed by the demo key or Freighter) and opens a genuine SEP-24 deposit
  session at the anchor's hosted UI, from the browser.

Honest scope: SDF's testanchor is a *reference* anchor (no real KYC on testnet) and
it issues **Circle testnet USDC** (issuer `GBBD47IF…`), whereas the corridor demo is
pre-funded with a project USDC SAC (issuer `GC7SWGHR…`) — so the on-ramp demonstrates
the live SEP flow, it is **not** the corridor's deposit source. A production deploy
would align the corridor's settlement asset to a *licensed* anchor's USDC (a partner +
KYC step, not code). Tukar also **publishes** its own SEP-1 `stellar.toml`
(`/.well-known/stellar.toml`, served with the SEP-1 CORS header).

## Known limitations (by design, stated honestly)
- Merkle witness (path) computed off-chain; on-chain integrity enforced by the
  `merkleUpdate` proof — there is **no admin root backdoor**.
- Fiat anchor on/off-ramps mocked; ASP lists seeded manually; single corridor A→B.
- Phase-2 of the trusted setup is a single contribution (phase-1 is the real
  Hermez ceremony).
- Contracts are **not audited** — testnet only, no real assets.
