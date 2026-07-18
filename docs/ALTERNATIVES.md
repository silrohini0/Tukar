# Alternatives to externally-gated integrations

A few "deepen the ecosystem integration" opportunities normally require an external,
gated resource — a Launchtube API token, a Mercury account, a WebAuthn authenticator,
or a KYC'd anchor partner — none of which can be obtained or live-verified inside this
build/CI environment. Rather than ship an unverifiable stub (which the project's
no-fakes rule forbids), this doc records, for each one, the **native Stellar
alternative**, whether it's been **built and live-verified**, and the honest ceiling.

| Opportunity | Native alternative | Status |
|---|---|---|
| Launchtube paymaster (gasless) | **Fee-bump transactions (CAP-15)** | ✅ Built + live-verified on testnet |
| Mercury durable indexing | **Durable-contract-state reconstruction** | ✅ Already implemented (better for the accumulator) |
| Passkey smart-wallet | **`secp256r1_verify` host fn** (on-chain half) | ◑ On-chain primitive buildable; full UX needs a human authenticator |
| SEP-24 anchor (fiat ramp) | **SEP-10 web-auth** against the public testanchor | ◑ Handshake buildable; SEP-24 ramp needs a partner |

---

## 1. Launchtube → native fee-bump (CAP-15) — DONE, live-verified

A paymaster service like Launchtube exists so a user needs no XLM for transaction
fees: a relayer pays them. Stellar has this natively. A **fee-bump transaction** wraps
an inner transaction *authorized and signed by the user* and lets a separate **fee
source** account pay the entire network fee. No gated API token; pure protocol.

Because a fee-bump is an envelope around *any* inner transaction, it applies unchanged
to the corridor's Soroban `deposit`/`withdraw` invokes: a Freighter user signs the
inner invoke, the app's relayer pays the fee — gasless deposits/withdrawals.

**Proven on testnet** (`scripts/feebump-paymaster.mjs`, `npm run demo:feebump`): a
transaction signed by the demo key had its entire fee paid by a fresh, independent
paymaster account — `paymasterPaidXlm: 0.00002`, `signerDeltaXlm: 0` (the signer paid
nothing). Example tx: `ef9c15065b469e648839dc56639f8712fc029d450c59b188b3c7f434bc06a6a6`.

Remaining step to ship it in the UI: wrap the Freighter-signed inner invoke with this
fee-bump (demo key as relayer). That path is a few lines on top of the verified
primitive, but — like the Freighter signing path itself — it can only be exercised
end-to-end by a human with the extension, so it's documented rather than claimed.

## 2. Mercury → durable contract state — already solved, no external dep

Mercury is a hosted indexer for reconstructing state from contract events. Tukar does
not need it for its load-bearing path: the spendable Merkle tree is reconstructed from
**durable contract storage** (`leaves()` / `leaf_range(start,count)` / `leaf_count`),
which has **no event-retention dependency** — strictly more reliable than indexing
events, which testnet RPC ages out after ~10k ledgers. The on-chain `getEvents`
activity feed (`readRecentActivity`) is a best-effort *recent* view layered on top,
explicitly not a source of truth. A production deploy could point that feed at a
Mercury subscription for durable history, but the accumulator never relies on it.

## 3. Passkey smart-wallet → `secp256r1_verify` / ephemeral keys — partially buildable

The "shared public demo key" caveat (the no-install demo isn't access-controlled)
would be closed by a passkey-controlled smart wallet. Two native angles:

- **On-chain capability is real:** Stellar's `secp256r1_verify` host function (the
  primitive WebAuthn smart wallets verify against) is available on Soroban, so a
  smart-wallet contract that authenticates a passkey signature is buildable and
  **unit-testable in Rust with a known P-256 keypair** — no authenticator needed to
  prove the on-chain half works (the same way on-chain Poseidon was proven by unit
  test without putting it on the hot path).
- **Why an ephemeral per-visitor key does NOT work here (corrected):** an earlier
  draft suggested generating a fresh keypair per visitor to drop the shared key. That
  is wrong, and it's worth stating plainly. Tukar enforces **key-on-from compliance**:
  `deposit` does `from.require_auth()` and pins `sourceKey = field(from) =
  keccak256(from XDR) mod r` as a compliance public input that the proof must show is a
  member of the ASP allow-list (`aspRoot`). The allow-list holds exactly one real
  account — the demo key (`field(demoKey)` at index 0; the other 15 leaves are inert
  `h1(2000+i)` padding, not anyone's `field`). `aspRoot` is set once in the constructor
  and has **no runtime add-member entrypoint**. So a fresh ephemeral account's `field`
  is not in the list, no membership proof exists for it, and the deposit is rejected —
  client-side (`stellar.js`: "this account is not an approved ASP source") and on-chain.
  The shared-demo-key caveat is therefore **structurally tied to the compliant-deposit
  model**, not a lazy default: the demo must use *an approved account*, and the one
  approved account's key is shared so the no-install demo can deposit.
- **The only real way to close it** is a passkey **smart wallet whose CONTRACT ADDRESS
  is the approved ASP member** — then the passkey (not a shared secret) authorizes the
  one allowed depositor. That needs the browser WebAuthn UX, which genuinely requires a
  human authenticator and can't run in headless CI (same limit as Freighter). The
  on-chain half (`secp256r1_verify`) is buildable/unit-testable now, but it does not by
  itself close the caveat without the wallet + WebAuthn wiring.

## 4. SEP-24 anchor → SEP-10 web-auth — handshake buildable, ramp needs a partner

A real fiat on/off-ramp at the corridor edges is a SEP-24 interactive flow, which
requires a KYC'd anchor partner (business/legal, out of scope for a code-only build).
But the **SEP-10 web-authentication** handshake — GET a challenge transaction, sign it,
POST it back for a JWT — is a real anchor-protocol integration that can be built and
verified against the **public SDF testanchor** (`testanchor.stellar.org`) with no KYC.
That demonstrates the auth half of the anchor relationship; the SEP-24 deposit/withdraw
ramp stays honestly mocked (as stated in the README/ARCHITECTURE) until a partner
exists. We chose not to add SEP-10 in isolation because the JWT it yields has nothing
to authorize in this product without the SEP-24 ramp behind it.

---

## 5. Stellar Confidential Tokens (OpenZeppelin) — parity & what Tukar adopts

On 2026-06-30 Stellar shipped a **Confidential Tokens** developer preview
(OpenZeppelin contract suite + Nethermind **UltraHonk** verifier, Noir circuits, on
testnet). It's worth mapping honestly, because it overlaps Tukar's compliance surface.

**Different tier, by Stellar's own framing.** Confidential Tokens hide *balances and
amounts* but keep *sender/recipient visible* ("confidential, not anonymous"). The
preview post explicitly puts privacy-pool designs (it names Stellar Private Payments)
in a separate tier that "shields **both the parties and the amounts**." **Tukar is in
that privacy-pool tier** — the shielded transfer leg hides amount *and* counterparties,
which is the cross-border-remittance threat model. So this isn't an alternative we
"should have used"; it's a different, less-private tier of the same stack.

| Confidential Tokens primitive | Tukar |
|---|---|
| Selective disclosure | ✅ have it (disclosure circuit, verified on-chain) |
| Compliance allow/deny policy | ✅ have it (ASP allow-list root + deny-list, on-chain) |
| Auditor **view key** (passive read of amounts) | ◑ different model — Tukar uses holder-initiated disclosure proofs; a view key is a separate crypto design (encrypt amounts to an auditor key) |
| **Configurable policy engine** (swappable allow/deny registry) | ◑ **adopting** — see below |
| Per-account freeze (SAC passthrough) | 🚫 **not possible in this tier by design** — Tukar accounts are anonymous, so there's no visible account to freeze. The honest equivalent: because Tukar custodies **real USDC SAC**, the issuer's SAC controls still apply to the *pool's* balance as a whole (not per shielded note). Per-account freeze is the price of counterparty privacy. |
| UltraHonk / Noir verifier | 🚫 a full rewrite; Tukar's Groth16/BN254 is mature and live-verified. Not worth re-targeting. (Note: this preview *does* make UltraHonk testnet-real, correcting the earlier "not yet feasible" read.) |

**What we adopt:** the **configurable compliance policy** idea. Tukar's `aspRoot` +
`denyList` were fixed at construction; we add admin setters (`set_asp_root`,
`set_deny_list`) + read-back views (`asp_root`, `deny_list`) so the policy can be
updated without redeploying the pool — the same "swap the allow/deny registry" property
Confidential Tokens exposes, on the privacy-pool tier. The compliance *circuit* is
unchanged (these are already public inputs the pool builds from storage); the frontend
reads the live `deny_list` before proving so a policy change can't desync the proof.

---

## 6. The anchor SEP stack (SEP-1 / 6 / 10 / 24 / 31) — what's real vs KYC-gated

Community feedback (Stellar Discord): *"simulated anchor… you should integrate
SEP-1, SEP-6, SEP-10, SEP-24 and SEP-31 if you are making your anchor."* Correct
list — for **building an anchor**. But Tukar isn't an anchor: it's the confidential
on-chain **settlement rail that sits between anchors**. So the honest mapping is:

**`npm run sep:anchor`** exercises the client/wallet side of the whole stack **live
against SDF's public reference anchor** (`testanchor.stellar.org`) — real HTTP, real
signatures, no mocks (**5/5 steps pass**):

| SEP | What it is | Tukar |
|---|---|---|
| **SEP-1** (`stellar.toml`) | org/asset/contract discovery | ✅ **published** — [`/.well-known/stellar.toml`](../frontend/.well-known/stellar.toml) declares the org + the live Soroban contracts (pool + 4 verifiers), network, operating account. Deliberately omits anchor endpoints and claims no `[[CURRENCIES]]` (Tukar issues no asset — settles in Circle/SDF USDC). Also **consumed**: `sep:anchor` reads the anchor's toml to discover its endpoints. |
| **SEP-10** (web-auth) | challenge → sign → JWT | ✅ **real JWT obtained** — fetches the anchor's challenge tx, signs it with the demo key, POSTs it back, gets a valid ~400-char JWT. Genuine anchor authentication, not a stub. |
| **SEP-6** (programmatic) | non-interactive deposit/withdraw | ✅ **authenticated `/info`** read live (anchor supports USDC/SRT/native deposit + withdraw). |
| **SEP-24** (interactive) | hosted deposit/withdraw | ✅ **real interactive URL** — an authenticated `POST …/transactions/deposit/interactive` for **USDC** returns a live hosted ramp URL (`anchor-ref-ui-testanchor.stellar.org?transaction_id=…&token=…`) + a transaction id. This is a genuine fiat-on-ramp session against a real anchor. |
| **SEP-31** (cross-border) | sending-anchor → receiving-anchor | ◑ `/info` reached live (the anchor advertises the SEP-31 endpoint; the testnet reference anchor has no receive assets configured). **This is where Tukar fits**: a SEP-31 pair handles fiat + KYC (SEP-12) + quotes (SEP-38) at each edge, and Tukar is the amount-and-counterparty-**private** settlement leg between them — the confidential middle a plain SEP-31 corridor lacks. |

So the protocol wiring is **real and verifiable**, not mocked: Tukar authenticates
and opens an interactive USDC on-ramp against a real anchor. **Honest scope:** SDF's
testanchor is a *reference* anchor (no real KYC on testnet); a production deploy
points these at a *licensed* anchor issuing the corridor's asset — that last mile is
business/legal (a partner + KYC), not code. Claiming Tukar *operates* a KYC'd anchor
would be a fake; integrating against one (as a wallet does) is real, and shipped.

---

**Bottom line:** the one opportunity with a clean native substitute that is also
fully live-verifiable — gasless via fee-bump — is built and proven. The rest are
either already obviated by a better design (Mercury) or genuinely gated on a human
authenticator / KYC partner, with the buildable sub-parts noted honestly. Against the
new Confidential Tokens preview, Tukar sits in the more-private privacy-pool tier and
adopts its one cleanly-applicable idea (configurable policy).
