# Tukar — Threat Model & Security

This is the security spine of the project: what Tukar protects, the attacks it
defends against, and **how each defense is verified** (unit test, on-chain error,
or live browser test). Tukar is a **testnet** project and is **not audited** — do
not use with real assets — but every property below is exercised, not asserted.

## Assets we protect

| Asset | Property |
|---|---|
| **Note privacy** | Amounts and counterparties of in-corridor transfers stay hidden on-chain — only commitments and nullifiers are public. |
| **Pool funds (USDC)** | The pool releases tokens only for a valid, *bound* withdraw — never more than a proof authorizes, never to replay a spent note. |
| **Tree integrity** | The Merkle accumulator can only grow by a *proven* insertion; no party can forge a root or a membership. |
| **Compliance soundness** | A deposit must carry a valid ASP-membership proof; a disclosure cannot lie about an amount. |

## Design principle: binding

The single most important property. **The pool never accepts a pre-built
`Vec<Bn254Fr>` of public inputs.** It receives the public signals as *typed
values* (root, nullifiers, commitments, amount) and **builds the verifier's
public-input vector itself**, in circuit order — then uses those same values for
its own logic. So a caller cannot present a proof that verifies while spending
*different* nullifiers, recording *different* commitments, advancing a *different*
root, or releasing a *different* amount: any mismatch changes the public inputs
and the proof fails. Every defense below rests on this.

## Threats & mitigations (all verified)

| # | Attack | Mitigation | Verified by |
|---|---|---|---|
| T1 | **Double-spend** a note | Per-input nullifier published + recorded; replay rejected | `NullifierUsed` (#2) — unit + live |
| T2 | **Double-spend bypass**: a *valid* transfer proof, but submit *different* nullifiers to the pool | Pool builds the verifier inputs from the typed nullifiers itself (binding) → proof no longer matches | `InvalidProof` (#0) — live (tampered nullifiers) |
| T3 | **Amount decoupling**: deposit a commitment whose hidden value ≠ the USDC moved | `deposit` also requires a disclosure proof that the commitment *opens to exactly* `amount` | deposit amount-binding — unit + live |
| T4 | **Over-withdraw**: tell the pool to release more than the proof authorizes | Released `amount` is bound to the proof's verified `public_amount` (the field-negative `r − amount`) | `AmountNotBound` (#6) — unit + live |
| T5 | **Forged tree root**: operator registers an arbitrary root | Root advances *only* via `register_root_verified` with a `merkleUpdate` proof that inserting `new_leaf` into the known root yields `new_root`; the admin override was removed | fake-root → `InvalidProof` (#0); no admin path — unit + live |
| T6 | **Break the accumulator**: insert from a stale/old root to fork the tree | `register_root_verified` requires `old_root == current_root` (single append-only accumulator) | `UnknownRoot` (#1) on stale root — unit + observed live |
| T7 | **Spend into an unknown root** | `transfer`/`withdraw` require a *known* root | `UnknownRoot` (#1) — unit |
| T8 | **Disclose an unknown commitment** to a regulator | `disclose` requires the commitment to be in the pool's set | `UnknownCommitment` (#3) — unit |
| T9 | **Lie in a disclosure** (claim a false amount) | Groth16 soundness — a false witness can't be proven; a tampered public input fails verification | rejected off-chain **and** on-chain (`InvalidProof`) — live |
| T10 | **Deposit from a non-allow-listed / sanctioned source** | Compliance proof: the **authenticated depositor** (`field(from)`, pinned by the pool + `require_auth`) ∈ ASP allow-list **and** ∉ deny-list, bound to the commitment | compliance soundness 6/6 (`test:negative`) + live (deposit only succeeds for an allow-listed, signing key) |
| T11 | **Forge value** (mint shielded value via field wrap) | **Input and output** amounts are range-checked to 248 bits, so value conservation `sum(in)+publicAmount = sum(out)` is provably wrap-free | circuit constraints + `test:negative` |
| T12 | **Trusted-setup toxic waste** (forge any proof) | Phase-1 from the real **Hermez** perpetual Powers-of-Tau ceremony (no locally-known waste) | `deployments/testnet.json` → `trustedSetup` |
| T13 | **Unbacked-leaf drain**: skip `deposit`, insert a self-made commitment as a tree leaf via `register_root_verified`, then `withdraw` against it — minting a spendable note with no tokens behind it | `register_root_verified` now requires `new_leaf` to be a commitment already **recorded by a real `deposit`** (or a `transfer`/`withdraw` change-note output), and inserts each commitment **at most once** | `UnknownCommitment` (#3) for an un-deposited leaf, `LeafAlreadyInserted` (#9) for a re-insert — unit (`register_root_verified_rejects_undeposited_leaf` / `…_rejects_double_insert`) + live |
| T14 | **Accumulator-griefing DoS**: prove a leaf insertion at an empty index ≠ `LeafCount` (the merkleUpdate `leafIndex` was private) — the contract stores the leaf at `LeafCount` but advances `current_root` to a different tree shape, so the durable `leaves()` list can no longer reproduce `current_root` and the shared tree is bricked (no more registers, no withdraws) for ~100 stroops | `leafIndex` is now a **public** merkleUpdate input; the pool builds the verifier's public-input vector with `leafIndex = its own LeafCount`, so the proven index must equal the stored slot | a mismatched-index proof fails Groth16 verification by construction; honest 4-public-input register verified live end-to-end |
| T15 | **Transfer value-mint → full drain**: the public `transfer` entrypoint moved no tokens and didn't constrain `public_amount`. The circuit only enforces `sum(in)+publicAmount = sum(out)` and zero-amount inputs skip the Merkle check — so a proof with two zero dummy inputs and `public_amount = +X` mints a fully-backed output commitment from nothing, which can then be registered into the tree and withdrawn for X real USDC (no deposit needed) | `transfer` now **binds `public_amount` to zero** — a pure shielded transfer conserves value entirely inside the shielded set; any external value must go through `deposit` (positive) or `withdraw` (negative) | `AmountNotBound` (#6) — unit (`transfer_rejects_nonzero_public_amount`) + 36/36 suite; honest deposit→register→withdraw flow re-verified live on the redeployed pool |
| T16 | **Archival double-spend**: spent-nullifier markers weren't TTL-extended (unlike leaves/roots), so on a long-lived pool a nullifier could be archived while its note stayed provable — letting the same note be spent twice after eviction | `spend_nullifiers` now extends each nullifier's persistent TTL to match the leaf/root TTL, so a spent marker never decays while its note is still reachable | code + unit suite (the double-spend guard `NullifierUsed` #2 is now archival-safe) |
| T17 | **Unpinned I/O split → double-spend (critical, audit round 7)**: the Groth16 verifier sees only a *flat* public-input vector, and `transfer`/`withdraw` never pinned how many entries are nullifiers vs. commitments. A caller could shift the boundary — pass 1 nullifier + 3 commitments instead of 2+2 — yielding the byte-identical 7-element vector, so the *same* valid proof verifies, but `spend_nullifiers` then burns only 1 nullifier; the 2nd input note's nullifier is recorded as a commitment, never marked spent, and stays double-spendable → pool drain | `transfer_inputs` (the chokepoint both `transfer` and `withdraw` route through) now pins `nullifiers.len() == 2 && out_commitments.len() == 2` → `BadIoCount` (#13) before the proof is even built | unit (`transfer_rejects_shifted_io_split`, `withdraw_rejects_shifted_io_split`; 36/36); pool redeployed with the fix |
| T18 | **Oracle spot manipulation of the settlement gate** (audit round 9): the withdraw min-receive gate priced against a single Reflector *spot* (`lastprice`), so a transient manipulation or glitch of that one reading could lower the floor and force a withdrawal to settle below fair value | The gate now prices against the **median of the last 5 Reflector records** (`prices(asset, records)`) — robust to a single outlier; the newest record must still be fresh (≤1h, fails closed on a stall) and the feed must return ≥3 records (else `FxUnavailable`); display stays on spot | unit (`withdraw_oracle_gate_median_ignores_spot_outlier` — a high spot outlier is ignored, `…_rejects_thin_feed` #11; 36/36); live (`offramp_quote_twap` median == spot on a stable feed) |
| T19 | **Admin re-points the compliance policy** (configurable-policy feature): `set_asp_root` / `set_deny_list` let the admin change who may deposit | **By design, and bounded**: both are `require_auth(admin)`-gated and emit/expose the new values via `asp_root()` / `deny_list()` views (publicly auditable); `set_deny_list` keeps the fixed `DENY_LEN` the circuit expects. This is the same admin-trust surface as `set_fx_oracle` and **cannot** mint value, forge proofs, move custody, or bypass a nullifier — it only updates the *policy* the compliance proof is checked against. A production deploy would put `admin` behind a multisig / governance contract. The compliance *circuit* and the binding remain trustless. | unit (`set_asp_root_updates_view`, `set_deny_list_updates_view`, `set_deny_list_rejects_wrong_len`); live (set→restore on the deployed pool, txs in `deployments/testnet.json`) |

## Trust assumptions (honest)

- **ASP curation** — Tukar enforces *membership* in the allow/deny sets
  cryptographically, but *who is on those lists* is an off-chain policy decision
  (seeded manually here; a real ASP operator owns it).
- **Anchors** — fiat on/off-ramps are mocked; we assume regulated anchors at the
  edges in production.
- **Phase-2 of the setup** — a single Tukar contribution (phase-1 is the real
  ceremony); production wants a multi-party phase-2.
- **Demo signing key** — writes are signed by a **throwaway, non-admin testnet
  key** embedded in the frontend so anyone can try the demo with no wallet (free
  testnet XLM only). Optional **Freighter** lets a user sign with their own wallet.
  Never reuse the embedded-key pattern for real funds. **Privacy caveat:** because
  one key sits on *both* edges in the default demo (it deposits and, by default,
  receives the withdrawal), **every demo payment is trivially self-linked on-chain** —
  the demo exercises the proving/custody/compliance machinery, not the anonymity set
  (which only exists with many independent users). See *Privacy model* below.

## Adversarial self-audit (findings + status)

A read-only adversarial audit of the contract, frontend, and circuits surfaced
the following. **Fixed** items are in the deployed contract; **Known** items are
honest limitations of this testnet build (not yet fixed) with the production fix
noted.

| Finding | Severity | Status |
|---|---|---|
| **Verifier return value was discarded** — `verify()` relied on the verifier *trapping* on a bad proof and ignored its `bool`. | high | **Fixed** — `verify()` now asserts the result (`ProofRejected`), so a verifier that returns `false` can't make a check a no-op. |
| **Deposit amount range** — `amount` is `i128` but the disclosure binding circuit range-checks to 64 bits, so `amount ≥ 2⁶⁴` failed as a confusing proof trap. | medium | **Fixed** — `deposit` rejects `amount ≥ 2⁶⁴` cleanly (`InvalidAmount`). |
| **Tree capacity** — `register_root_verified` didn't bound `LeafCount` against the depth-10 capacity (the circuit gated it, but the contract shouldn't rely on that for its own storage invariant). | medium | **Fixed** — rejects insert past `2¹⁰` leaves (`TreeFull`). |
| **Stale local leaf index on withdraw** — the client trusted a locally-tracked `leafIndex`. | medium | **Fixed (client)** — withdraw locates the note's real index by its commitment in the freshly-synced tree. |
| **Compliance proof authenticates nobody** — the membership witness used to be any public allow-list entry, so the proof showed "*some* allow-listed source exists", not that *this depositor* is approved. | high | **Fixed (key-on-`from`)** — the compliance circuit's `sourceKey` is now a **public** input; the pool pins it to `field(from) = keccak256(from XDR) mod r` and `require_auth(from)`s. The allow-list holds `field(approvedKeys)`, so the proof shows **this authenticated depositor** is allow-listed; an unapproved key can't deposit. Verified live (deposit only succeeds because `addrField(from)` matches the contract and an allow-list member). *Caveat:* the shared demo key's secret is public, so the **public demo** isn't access-controlled — but the design is correct for real-wallet (Freighter) users. |
| **Withdraw recipient not bound by the proof** — `ext_data_hash` was a free, caller-supplied public input, so a withdraw proof + nullifiers could be replayed to a *different* recipient. | high | **Fixed** — `withdraw` no longer accepts `ext_data_hash`; it **recomputes** it on-chain as `keccak256(recipient XDR ‖ public_amount)` and feeds that to the verifier. The browser generates the proof with the same value, so the proof commits to the recipient; a replay with another recipient yields a different hash and **fails verification**. Verified live (the withdraw only succeeds because the browser keccak matches the contract's). |
| **Unbacked-leaf drain (critical)** — `deposit` recorded a commitment and moved tokens in but did **not** insert the leaf; the tree was advanced only by the *permissionless* `register_root_verified`, which accepted an **arbitrary** `new_leaf`. So an attacker could skip `deposit` entirely, insert a self-made commitment with a valid `merkleUpdate` proof (which only attests the root math, not backing), and `withdraw` against it — draining other users' deposits. A second variant inserted one deposited commitment **twice** (two indices → two nullifiers → double the value). | **critical** | **Fixed** — `register_root_verified` now requires `new_leaf` to be a commitment already recorded by a real `deposit` (or a `transfer`/`withdraw` change-note output) → `UnknownCommitment` (#3), and marks it inserted so a re-insert is rejected → `LeafAlreadyInserted` (#9). Unit-tested (`register_root_verified_rejects_undeposited_leaf`, `…_rejects_double_insert`; 36/36) and verified live on-chain. |
| **Accumulator-griefing via unconstrained `leafIndex` (high)** — the merkleUpdate `leafIndex` was private; the contract stored the leaf at `LeafCount` but the proof could attest insertion at a *different* empty index, desyncing the durable `leaves()` list from `current_root` and permanently bricking the shared tree for ~100 stroops (no fund theft, total liveness kill). | **high** | **Fixed** — `leafIndex` is now a **public** merkleUpdate input; the pool feeds its own `LeafCount` as that public signal, so the proven insertion index must equal the slot it stores into. Redeployed merkleUpdate verifier (4 public inputs) + pool; honest flow verified live end-to-end. |
| **Duplicate-commitment deposit locks funds (medium)** — two `deposit`s with the same commitment both moved tokens in, but only one could ever become a spendable leaf (insert-once), stranding the rest. | **medium** | **Fixed** — `deposit` rejects an already-recorded commitment (`DuplicateCommitment` #10) before any tokens move; `record_commitment` also bumps the commitment's TTL so a not-yet-registered deposit can't have its backing record archived. |
| **Transfer input amounts not range-checked (defense-in-depth)** — `transfer.circom` range-checked outputs to 248 bits but not inputs; value conservation was sound *only* because every tree leaf is inductively ≤2²⁴⁸ (deposits 64-bit, outputs 248-bit), so a 2-input sum can't wrap the field. | low/latent | **Fixed** — each `inAmount` is now range-checked to 248 bits (`Num2Bits(248)`, a zero dummy passes), making wrap-freeness explicit rather than reliant on the cross-component invariant. Transfer verifier + zkey regenerated (15884 constraints) and redeployed; pool repointed. Verified live (valid spends still pass). |
| **Historical roots are never pruned / no revocation** — spends accept any *known* root (standard Tornado design). | **Known/accepted** | Double-spend is still blocked by the nullifier set; a production system would add a root/leaf revocation path for compliance. |
| **Backing-record archival liveness** — a deposit records its commitment (TTL ~31d) but if it's *never* registered into the tree within that window the record can be archived, after which `register_root_verified` would reject it (`UnknownCommitment`) and the deposited tokens are stranded (no refund path). | **Known/low (liveness)** | In practice the client registers immediately after depositing, so the window is never approached; a production rev would refresh the commitment TTL inside `register_root_verified` and/or add an owner reclaim path for never-registered deposits. |
| **Dummy zero-value output commitments are recorded + disclosable** — a full withdraw creates throwaway 0-value outputs that inflate `commitment_count` and are `disclose`-able as "amount 0". | low | Cosmetic; would skip recording zero-value outputs in a production rev. |

Items the audit checked and found **sound**: the binding property (public inputs
rebuilt from typed signals), the amount↔field-negative withdraw binding, nullifier
double-spend protection, `record_commitment` idempotency, the accumulator
`old_root == current_root` invariant, output range-checks, value conservation,
`leaf_range` clamping, the `syncedLeaves` verify-before-trust gate, and
no reentrancy via `token.transfer` (state finalized before the outbound transfer).

### Second audit round (on the recipient-binding + key-on-`from` fixes)

A follow-up audit of the two new fixes confirmed **both are cryptographically
sound** — no critical/high break:
- *Recipient binding:* `extDataHash` is a declared public signal, so Groth16 binds
  the proof to it even though the circuit only squares it; recomputing it from
  `recipient` makes a redirected replay fail. Recipient **and** amount are bound.
- *Depositor auth:* `require_auth(from)` genuinely prevents borrowing an approved
  identity; pinning `sourceKey = field(from)` + the private membership path means a
  forged proof with someone else's witness can't pass. Public-input orders match.
- *Mod-r agreement:* the browser's `keccak % r` equals the contract's
  `Bn254Fr::from_bytes` because the SDK reduces mod r — true on soroban-sdk
  **≥ 25.3.0** (CVE-2026-32322); we pin `26` (see `Cargo.toml` note).

Acted on:
- **Deny-list now holds `field(sanctioned account)`** (same derivation as
  `sourceKey`), so non-membership is meaningful — fixed (was placeholder values).
- **Re-broadcast race** (low): an observer can copy a pending withdraw and submit it
  with the *same* recipient; the loser just gets `NullifierUsed` — **no fund loss**
  (the recipient is bound, so funds still reach the intended party). A per-tx
  ext-data nonce would remove the nuisance; out of scope for the demo.
- **localStorage note secrets** (low): bounded by the throwaway-demo-key model; for
  real funds, secrets must not touch `localStorage` and the `esm.sh` scripts should
  be SRI-pinned/self-hosted.

## Privacy model & anonymity set (honest scope)

Tukar follows the Privacy-Pools model: **visible deposits/withdrawals, private
transfers**. It is important to be precise about what that does and does not hide.

- **The in-corridor transfer leg is genuinely private.** `transfer` binds
  `public_amount == 0` and emits only the root — the amount and counterparties of a
  shielded transfer never touch the chain. This is the cryptographic core and it
  holds.
- **The deposit and withdraw EDGES are public — by design.** Real USDC custody moves
  there, so `deposit` takes a cleartext `amount` and emits `(commitment, amount)`, and
  `withdraw` emits `(recipient, amount)`. The amounts and the on/off-ramp addresses at
  the edges are **not** hidden.
- **Privacy is therefore *unlinkability of the graph*, and its strength = the
  anonymity set** — the number of concurrent same-amount notes a deposit could
  correspond to. A passive observer who sees a deposit of amount X and a withdrawal of
  amount X can link them *unless* many other in-flight notes share that amount.
- **Tukar uses arbitrary amounts, not fixed denominations.** Unlike Tornado / the
  Privacy-Pools whitepaper (which use fixed buckets precisely to grow the anonymity
  set), an arbitrary amount like `1,437.22 USDC` is a near-unique fingerprint, so the
  effective anonymity set can be as small as **one**. The JoinSplit `transfer` *can*
  re-denominate value between the edges to break the exact-amount match, but the demo
  flow withdraws the full deposited amount and does not exercise that.
- **The shared demo key collapses it to zero** (see the demo-key caveat above): one
  key on both edges self-links every payment.

**Honest note on the "fix".** Fixed-denomination notes (Tornado / Privacy-Pools) are
the textbook anonymity-set grower, but they fit *remittance* poorly: a remittance is an
exogenous specific amount, so bucketing `1,437.22` into `1×1000 + 4×100 + 3×10 + 7×1`
just re-encodes the amount in the note **count and bucket-mix** (and the `$0.22` has no
bucket), and Tukar's 2-in/2-out `transfer` would need several sequential splits — a real
circuit/UX redesign, not a config flip. So for arbitrary-amount remittance, link-privacy
is fundamentally an **operational** property, and the honest levers are: (1) a large
concurrent same-corridor user base; (2) deposit/withdraw **batching + timing
decorrelation** (a relayer/queue so edges don't pair 1:1 in time); (3) **not** withdrawing
the exact deposited amount — using the JoinSplit re-denomination that already exists
between the edges (which the demo does not currently exercise). Denominations are at best
a partial, poorly-fitting structural mitigation here; we do not claim them as a clean fix.

## Out of scope (this testnet build)

- Not audited; no formal verification of the circuits.
- Metadata/timing side-channels (tx timing; edge amounts/addresses — see *Privacy
  model* above for the linkability consequence) are not obfuscated.
- A very-long-lived production pool needs a TTL-maintenance job and an indexer
  (see the tree-scale note in the README); not required at demo scale.
- Relayer/fee privacy (who pays the tx fee) is not addressed.

## How to reproduce the checks

- **Contract unit tests** (36/36): `cd contracts/pool && cargo test` — covers
  T1, T3, T4, T6, T7, T8, plus accumulator + leaf-storage + on-chain Poseidon.
- **Circuit soundness** (6/6): `npm run test:negative` — covers T9, T10, T11.
- **In-browser proving** (valid/tampered/false-witness): `npm run test:proving`.
- **Live end-to-end** (deposit → register → withdraw → disclosure → tamper
  rejected, all on testnet): `node scripts/browser-test.mjs <url>` — covers T2,
  T4, T5, T9 against the deployed contracts.

See [`TESTING.md`](TESTING.md) for the full result tables and
[`deployments/testnet.json`](../deployments/testnet.json) for live contract ids.
