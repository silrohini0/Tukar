#![no_std]

//! Tukar pool — the stateful corridor contract that orchestrates the three ZK
//! verifiers and custodies the corridor's tokens.
//!
//! **Binding (the key security property).** The pool never accepts a pre-built
//! `Vec<Bn254Fr>`. It receives the public signals as typed values and *builds*
//! the verifier's public-input vector itself, in circuit order. The same values
//! are then used for the pool's own logic (root check, nullifier spend,
//! commitment recording, token amount). A caller therefore cannot present a
//! valid proof while spending different nullifiers, recording different
//! commitments, or withdrawing a different amount — any mismatch changes the
//! public inputs and the proof fails to verify.
//!
//! **Custody.** `deposit` pulls `amount` tokens from the depositor into the pool;
//! `withdraw` releases tokens to a recipient, where the released `amount` is
//! bound to the proof's verified `public_amount`. Token = a SAC address (the
//! demo uses the SAC of real testnet USDC — issuer `GC7SWGHR…` — not a stand-in).

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    symbol_short,
    token::TokenClient,
    vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

mod poseidon;
mod poseidon_constants;

const VERIFY: Symbol = symbol_short!("verify");
const DENY_LEN: u32 = 4;
// Persistent-state TTL bounds: when a tree leaf / root entry's remaining TTL falls
// below the threshold (~1 day), extend it to ~31 days, so a long-lived accumulator
// keeps its leaves/roots readable without per-entry maintenance from the caller.
const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 535_680;

/// Groth16 proof — identical layout to the verifier's `Groth16Proof`.
#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PoolError {
    UnknownRoot = 1,
    NullifierUsed = 2,
    UnknownCommitment = 3,
    BadDenyList = 4,
    InvalidAmount = 5,
    AmountNotBound = 6,
    ProofRejected = 7,
    TreeFull = 8,
    LeafAlreadyInserted = 9,
    DuplicateCommitment = 10,
    FxUnavailable = 11,
    SlippageExceeded = 12,
    BadIoCount = 13,
}

// The transfer/withdraw JoinSplit is fixed at 2 inputs and 2 outputs (Transfer(10,2,2)).
// The Groth16 verifier only sees a FLAT public-input vector, so the contract MUST pin
// how many of those are nullifiers vs. commitments — otherwise a caller could shift the
// boundary (e.g. 1 nullifier + 3 commitments instead of 2+2): the flat vector is
// identical so the same proof verifies, but only 1 nullifier gets spent and the second
// input note stays unspent -> double-spendable. Pinning the counts closes that.
const TRANSFER_NINS: u32 = 2;
const TRANSFER_NOUTS: u32 = 2;

// USDC SAC has 7 decimals, so 1 whole USDC = 10^7 stroops. The off-ramp quote works
// in whole-USDC units (what the receiver sees), so the withdraw gate converts the
// released stroop amount to whole USDC before pricing it against the oracle.
const USDC_STROOPS: i128 = 10_000_000;
// Max age (seconds) of a Reflector price before the pool treats the feed as
// unavailable. Mirrors the frontend's 1-hour bound so display and on-chain
// settlement agree; the Reflector testnet feed updates every ~2 min, so a healthy
// feed passes comfortably. A frozen-but-positive stale price must NOT be used as a
// live rate by the settlement gate — so staleness fails closed (FxUnavailable).
const FX_MAX_STALENESS: u64 = 3600;
// The withdraw SETTLEMENT gate prices against the MEDIAN of the last N Reflector
// records, not a single spot price — so a transient manipulation or glitch of one
// record can't move the floor (the median of N is robust to an outlier). FX_MIN_RECORDS
// is the minimum the feed must return, so a thin feed can't silently degrade the median
// back to a single spot read; below it the gate fails closed (FxUnavailable).
const FX_GATE_RECORDS: u32 = 5;
const FX_MIN_RECORDS: u32 = 3;

#[contracttype]
enum DataKey {
    Admin,
    Token,
    TransferVerifier,
    ComplianceVerifier,
    DisclosureVerifier,
    UpdateVerifier,
    AspRoot,
    DenyList,
    CurrentRoot,
    Count,
    LeafCount,            // number of leaves inserted into the Merkle tree
    Leaf(u32),            // the commitment at tree leaf index i (durable, ordered)
    Inserted(BytesN<32>), // commitments already inserted as a leaf (insert-once guard)
    Root(BytesN<32>),
    Nullifier(BytesN<32>),
    Commitment(BytesN<32>),
    FxOracle, // Reflector SEP-40 oracle address (USD-base FX feed)
}

// ---- Reflector SEP-40 oracle interface (the subset the pool calls) ----
// Mirrors the partner contract's types so the pool can invoke it cross-contract.
#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contract]
pub struct Pool;

#[contractimpl]
impl Pool {
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        transfer_verifier: Address,
        compliance_verifier: Address,
        disclosure_verifier: Address,
        update_verifier: Address,
        initial_root: BytesN<32>,
        asp_root: BytesN<32>,
        deny_list: Vec<BytesN<32>>,
        fx_oracle: Address,
    ) {
        if deny_list.len() != DENY_LEN {
            soroban_sdk::panic_with_error!(&env, PoolError::BadDenyList);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::TransferVerifier, &transfer_verifier);
        s.set(&DataKey::ComplianceVerifier, &compliance_verifier);
        s.set(&DataKey::DisclosureVerifier, &disclosure_verifier);
        s.set(&DataKey::UpdateVerifier, &update_verifier);
        s.set(&DataKey::AspRoot, &asp_root);
        s.set(&DataKey::DenyList, &deny_list);
        s.set(&DataKey::CurrentRoot, &initial_root);
        s.set(&DataKey::Count, &0u32);
        s.set(&DataKey::FxOracle, &fx_oracle);
        env.storage()
            .persistent()
            .set(&DataKey::Root(initial_root), &());
    }

    /// Admin-only: update the Reflector FX oracle address (e.g. if the partner
    /// redeploys its testnet feed). Keeps the off-ramp quote pointed at a live feed
    /// without redeploying the whole pool.
    pub fn set_fx_oracle(env: Env, oracle: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::FxOracle, &oracle);
    }

    /// The Reflector FX oracle this pool reads for off-ramp quotes.
    pub fn fx_oracle(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FxOracle).unwrap()
    }

    /// Admin-only: replace the ASP allow-list root (the allow-list "policy
    /// registry"). Lets the compliance policy evolve WITHOUT redeploying the pool —
    /// the configurable-policy property Stellar's Confidential Tokens expose, here on
    /// the privacy-pool tier. The compliance circuit reads `aspRoot` as a public
    /// input the pool builds from storage, so this re-points the membership check;
    /// the operator must publish a matching allow-list witness for provers.
    pub fn set_asp_root(env: Env, asp_root: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::AspRoot, &asp_root);
    }

    /// Admin-only: replace the deny-list (the block-list "identity registry"). Must
    /// keep the fixed length the circuit expects (`DENY_LEN` public inputs); updating
    /// the values re-points the non-membership check without a redeploy.
    pub fn set_deny_list(env: Env, deny_list: Vec<BytesN<32>>) {
        if deny_list.len() != DENY_LEN {
            soroban_sdk::panic_with_error!(&env, PoolError::BadDenyList);
        }
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::DenyList, &deny_list);
    }

    /// The current ASP allow-list root — so a client can confirm its membership
    /// witness matches the live policy before proving.
    pub fn asp_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::AspRoot).unwrap()
    }

    /// The current deny-list — so a client builds the compliance proof's public
    /// inputs from the LIVE policy, not a stale hardcode.
    pub fn deny_list(env: Env) -> Vec<BytesN<32>> {
        env.storage().instance().get(&DataKey::DenyList).unwrap()
    }

    /// Off-ramp quote, computed ON-CHAIN by reading the Reflector SEP-40 oracle
    /// (contract-to-contract composability). Given a `symbol` the oracle carries
    /// (e.g. "MXN", base = USD) and a USDC amount (whole units), returns the local
    /// fiat the receiver would get at the live on-chain FX rate. The oracle reports
    /// the USD value of 1 local unit scaled by `decimals`, so:
    ///   local = usdc * 10^decimals / price.
    /// This is the figure the receiver panel reveals — derived by the pool reading
    /// Reflector, not by a client-side hardcode. It does NOT gate token release
    /// (`withdraw` settles in USDC and never depends on the oracle being live).
    pub fn offramp_quote(env: Env, symbol: Symbol, usdc_amount: i128) -> i128 {
        // Bound the input to the same 64-bit range as a deposit (real corridor
        // amounts are far smaller). Keeps the math well inside i128 regardless of
        // what the oracle reports, and gives a typed error instead of a trap.
        if usdc_amount < 0 || usdc_amount >= (1i128 << 64) {
            soroban_sdk::panic_with_error!(&env, PoolError::InvalidAmount);
        }
        Self::quote_local(&env, symbol, usdc_amount)
    }

    /// Manipulation-resistant off-ramp quote: like `offramp_quote`, but priced at the
    /// MEDIAN of the last `records` Reflector records — exactly what the withdraw
    /// settlement gate enforces. Exposed so a client can compute its min-receive floor
    /// on the SAME basis the gate uses (not a spot price that could diverge). Read-only.
    pub fn offramp_quote_twap(env: Env, symbol: Symbol, usdc_amount: i128, records: u32) -> i128 {
        if usdc_amount < 0 || usdc_amount >= (1i128 << 64) {
            soroban_sdk::panic_with_error!(&env, PoolError::InvalidAmount);
        }
        Self::quote_local_median(&env, symbol, usdc_amount, records)
    }

    /// Local fiat for `usdc_amount` whole USDC at the live Reflector SPOT rate, read
    /// ON-CHAIN (cross-contract). Used by the DISPLAY quote (`offramp_quote`). A
    /// stale/absent feed or an overflow yields a typed FxUnavailable, never a VM trap,
    /// so the display degrades gracefully. The load-bearing settlement gate uses the
    /// median path (`quote_local_median`) instead, for manipulation resistance.
    fn quote_local(env: &Env, symbol: Symbol, usdc_amount: i128) -> i128 {
        let oracle: Address = env.storage().instance().get(&DataKey::FxOracle).unwrap();
        let asset = Asset::Other(symbol);
        // Reflector: lastprice(asset) -> Option<PriceData>.
        let pd: Option<PriceData> = env.invoke_contract(
            &oracle,
            &Symbol::new(env, "lastprice"),
            vec![env, asset.into_val(env)],
        );
        // Reject an ABSENT feed (None), a non-positive price, AND a STALE price: a
        // frozen-but-positive price must not pass as a live rate. now - timestamp is
        // saturating so a price stamped at/after the ledger clock counts as fresh.
        let now = env.ledger().timestamp();
        let pd = match pd {
            Some(p) if p.price > 0 && now.saturating_sub(p.timestamp) <= FX_MAX_STALENESS => p,
            _ => soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable),
        };
        Self::price_to_local(env, &oracle, usdc_amount, pd.price)
    }

    /// Manipulation-resistant rate for the SETTLEMENT gate: read the last `records`
    /// Reflector records and price at their MEDIAN, so a single manipulated/glitched
    /// record can't move the floor (median of N is robust to one outlier). The NEWEST
    /// record must still be fresh (<= FX_MAX_STALENESS), so a stalled feed fails closed;
    /// the feed must return at least FX_MIN_RECORDS, so a thin feed can't degrade the
    /// median back to spot. Absent feed / too-few records / overflow -> FxUnavailable.
    fn quote_local_median(env: &Env, symbol: Symbol, usdc_amount: i128, records: u32) -> i128 {
        let oracle: Address = env.storage().instance().get(&DataKey::FxOracle).unwrap();
        let asset = Asset::Other(symbol);
        // Reflector: prices(asset, records) -> Option<Vec<PriceData>> (newest first).
        let pv: Option<Vec<PriceData>> = env.invoke_contract(
            &oracle,
            &Symbol::new(env, "prices"),
            vec![env, asset.into_val(env), records.into_val(env)],
        );
        let pv = match pv {
            Some(v) if v.len() >= FX_MIN_RECORDS => v,
            _ => soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable),
        };
        // Newest record (index 0) must be fresh, else a stalled feed could settle a gate.
        let now = env.ledger().timestamp();
        let newest = pv.get(0).unwrap();
        if newest.timestamp == 0 || now.saturating_sub(newest.timestamp) > FX_MAX_STALENESS {
            soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable);
        }
        let median = Self::median_price(env, &pv);
        Self::price_to_local(env, &oracle, usdc_amount, median)
    }

    /// Median of the record prices (each must be > 0, else FxUnavailable). Insertion-
    /// sorts a small Vec (N ~ 5, well within the CPU budget) and takes the middle; for
    /// an even count this picks the upper-middle, which only makes the floor slightly
    /// STRICTER — fund-safe (the gate can over-protect, never under-protect).
    fn median_price(env: &Env, prices: &Vec<PriceData>) -> i128 {
        let mut vals: Vec<i128> = vec![env];
        for p in prices.iter() {
            if p.price <= 0 {
                soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable);
            }
            vals.push_back(p.price);
        }
        let len = vals.len();
        let mut i = 1u32;
        while i < len {
            let key = vals.get(i).unwrap();
            let mut j = i;
            while j > 0 && vals.get(j - 1).unwrap() > key {
                let prev = vals.get(j - 1).unwrap();
                vals.set(j, prev);
                j -= 1;
            }
            vals.set(j, key);
            i += 1;
        }
        vals.get(len / 2).unwrap()
    }

    /// Convert a USD-base oracle `price` (scaled by the oracle's `decimals`) into local
    /// fiat for `usdc_amount` whole USDC: local = usdc * 10^decimals / price. Reads the
    /// oracle's decimals (so a feed-config change can't silently misscale) and uses
    /// checked math, so a buggy/hostile oracle yields FxUnavailable, never a VM trap.
    fn price_to_local(env: &Env, oracle: &Address, usdc_amount: i128, price: i128) -> i128 {
        let decimals: u32 = env.invoke_contract(oracle, &Symbol::new(env, "decimals"), vec![env]);
        let scale = match 10i128.checked_pow(decimals) {
            Some(s) => s,
            None => soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable),
        };
        // local = usdc * scale / price  (USD->local is the reciprocal of price/scale)
        match usdc_amount.checked_mul(scale) {
            Some(num) => num / price,
            None => soroban_sdk::panic_with_error!(env, PoolError::FxUnavailable),
        }
    }

    /// Trustless root advance (G6). Anyone may advance the tree, but only with a
    /// proof that inserting `new_leaf` at an empty slot of the **current** root
    /// yields exactly `new_root`. Requiring `old_root == current_root` makes the
    /// tree a single append-only **global accumulator**: every insert builds on
    /// the latest on-chain state. The ordered leaves are stored durably on-chain
    /// (read them back with `leaves()`), so any client can reconstruct the exact
    /// tree from contract STATE — no reliance on event retention.
    ///
    /// **Backing (critical).** The leaf must be a commitment the pool already
    /// recorded via a `deposit` (tokens moved in) or a `transfer`/`withdraw`
    /// change-note output (value conserved by its own proof), and it may be
    /// inserted at most once. Without these gates this entrypoint is permissionless
    /// and would accept ANY leaf — an attacker could insert a commitment they never
    /// deposited, then `withdraw` against it and drain the pool, because the
    /// merkleUpdate proof only attests the root math, not that the leaf is backed.
    pub fn register_root_verified(
        env: Env,
        proof: Groth16Proof,
        old_root: BytesN<32>,
        new_leaf: BytesN<32>,
        new_root: BytesN<32>,
    ) {
        let cur: BytesN<32> = env.storage().instance().get(&DataKey::CurrentRoot).unwrap();
        if old_root != cur {
            soroban_sdk::panic_with_error!(&env, PoolError::UnknownRoot);
        }
        // The leaf must be a real, backed commitment (see the "Backing" note above).
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Commitment(new_leaf.clone()))
        {
            soroban_sdk::panic_with_error!(&env, PoolError::UnknownCommitment);
        }
        // Insert-once: a second insertion of the same commitment at a different
        // index would mint a second spendable leaf (a different nullifier) from one
        // deposit — also a drain. Mark it consumed for insertion.
        let ins_key = DataKey::Inserted(new_leaf.clone());
        if env.storage().persistent().has(&ins_key) {
            soroban_sdk::panic_with_error!(&env, PoolError::LeafAlreadyInserted);
        }
        env.storage().persistent().set(&ins_key, &());
        // The depth-10 tree holds at most 2^10 leaves; `n` is also the slot we store
        // the leaf at AND the index we pin the proof to (below).
        let n: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LeafCount)
            .unwrap_or(0);
        if n >= 1u32 << 10 {
            soroban_sdk::panic_with_error!(&env, PoolError::TreeFull);
        }
        // Bind the proof's insertion index to OUR `LeafCount`. The merkleUpdate
        // circuit exposes `leafIndex` as a PUBLIC input; by feeding our own `n` here
        // we force the proof to attest insertion at exactly the slot we store the
        // leaf in. Without this, a prover could attest insertion at a different empty
        // index than `LeafCount`, desyncing the durable `leaves()` list from
        // `current_root` and permanently bricking the shared accumulator.
        let pi = vec![
            &env,
            Self::fr(&env, &old_root),
            Self::fr(&env, &new_leaf),
            Self::fr(&env, &new_root),
            Self::fr(&env, &Self::amount_bytes(&env, n as i128)),
        ];
        Self::verify(&env, DataKey::UpdateVerifier, &proof, &pi);
        Self::record_commitment(&env, &new_leaf);
        // Store the leaf at its tree index durably, so the ordered leaf list is
        // reconstructable from contract state (via `leaves()`) — reliably, with no
        // dependency on RPC event retention.
        env.storage().persistent().set(&DataKey::Leaf(n), &new_leaf);
        env.storage().instance().set(&DataKey::LeafCount, &(n + 1));
        env.storage()
            .persistent()
            .set(&DataKey::Root(new_root.clone()), &());
        env.storage()
            .instance()
            .set(&DataKey::CurrentRoot, &new_root);
        // Keep this leaf + root readable on a long-lived pool (TTL maintenance).
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Leaf(n), TTL_THRESHOLD, TTL_EXTEND);
        env.storage()
            .persistent()
            .extend_ttl(&ins_key, TTL_THRESHOLD, TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Root(new_root.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        env.events()
            .publish((symbol_short!("root"), new_leaf), new_root);
    }

    /// Compliant deposit: pull `amount` tokens from `from` into the pool and
    /// record the commitment — only with a compliance proof whose pinned ASP
    /// allow/deny inputs verify and whose bound hash is this commitment.
    pub fn deposit(
        env: Env,
        from: Address,
        amount: i128,
        commitment: BytesN<32>,
        proof: Groth16Proof,
        binding_proof: Groth16Proof,
    ) -> u32 {
        // amount must be positive and fit the disclosure circuit's 64-bit range
        // (the amount-binding proof can't be generated otherwise).
        if amount <= 0 || amount >= (1i128 << 64) {
            soroban_sdk::panic_with_error!(&env, PoolError::InvalidAmount);
        }
        // Reject a duplicate commitment up front: a second deposit to the same
        // commitment would move tokens in but could never become a second spendable
        // leaf (insert-once), permanently locking those tokens. Fail before any
        // token moves. (`transfer`/`withdraw` legitimately re-record outputs and
        // rely on `record_commitment` idempotence, so this guard is deposit-only.)
        if env
            .storage()
            .persistent()
            .has(&DataKey::Commitment(commitment.clone()))
        {
            soroban_sdk::panic_with_error!(&env, PoolError::DuplicateCommitment);
        }
        from.require_auth();

        // 1. Compliance: the AUTHENTICATED depositor `from` is an allow-listed
        // source, bound to this commitment. The contract derives the source key
        // itself as field(from) = keccak256(from XDR) mod r and sets it as the
        // compliance public input — so the proof shows *this* depositor is approved
        // (it can't be forged with someone else's public membership witness).
        // public inputs: [aspRoot, deny0..3, sourceKey=field(from), bindHash=commitment]
        let asp_root: BytesN<32> = env.storage().instance().get(&DataKey::AspRoot).unwrap();
        let deny: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::DenyList).unwrap();
        let mut pi = vec![&env, Self::fr(&env, &asp_root)];
        for d in deny.iter() {
            pi.push_back(Self::fr(&env, &d));
        }
        pi.push_back(Self::addr_field(&env, &from));
        pi.push_back(Self::fr(&env, &commitment));
        Self::verify(&env, DataKey::ComplianceVerifier, &proof, &pi);

        // 2. Amount binding: the commitment opens to exactly `amount` (disclosure
        // circuit: [commitment, disclosedAmount=amount, ctx=7]). This ties the
        // deposited token amount to the note's hidden value — no decoupling.
        let amt = Self::amount_bytes(&env, amount);
        let ctx = Self::amount_bytes(&env, 7);
        let bind_pi = vec![
            &env,
            Self::fr(&env, &commitment),
            Self::fr(&env, &amt),
            Self::fr(&env, &ctx),
        ];
        Self::verify(&env, DataKey::DisclosureVerifier, &binding_proof, &bind_pi);

        // 3. Move the real token amount in.
        Self::token(&env).transfer(&from, &env.current_contract_address(), &amount);

        let index = Self::record_commitment(&env, &commitment);
        env.events()
            .publish((symbol_short!("deposit"), index), (commitment, amount));
        index
    }

    /// On-chain Poseidon (circomlib-compatible, t=3) computed with the BN254 host
    /// field ops — returns the SAME hash the circuits/frontend use, verifiable by
    /// calling this on testnet. NOTE: one hash costs ~13.6M CPU, so a full depth-10
    /// Merkle insert (10 hashes ≈ 135M) exceeds the ~100M per-tx budget — which is
    /// exactly why the tree is advanced with a cheap merkleUpdate SNARK
    /// (`register_root_verified`, one pairing) instead of hashing on-chain.
    pub fn poseidon_hash(env: Env, a: BytesN<32>, b: BytesN<32>) -> BytesN<32> {
        poseidon::hash2(&env, &a, &b)
    }

    /// Trustless private transfer (JoinSplit). Inputs are built from the typed
    /// signals so the spent nullifiers and recorded commitments are exactly the
    /// ones the proof attests.
    pub fn transfer(
        env: Env,
        proof: Groth16Proof,
        root: BytesN<32>,
        public_amount: BytesN<32>,
        ext_data_hash: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,
        out_commitments: Vec<BytesN<32>>,
    ) {
        // A pure shielded transfer moves NO external value: it must conserve value
        // entirely inside the shielded set. The circuit only enforces
        // `sumIn + publicAmount == sumOut`, and zero-amount inputs skip the Merkle
        // membership check — so a positive `public_amount` with two zero-value dummy
        // inputs would MINT a fully-backed output commitment out of nothing (which
        // could then be registered into the tree and withdrawn for real tokens).
        // Bind `public_amount` to zero here; any external value MUST go through
        // `deposit` (tokens in, positive) or `withdraw` (tokens out, negative).
        if public_amount != Self::amount_bytes(&env, 0) {
            soroban_sdk::panic_with_error!(&env, PoolError::AmountNotBound);
        }
        Self::require_known_root(&env, &root);
        let pi = Self::transfer_inputs(
            &env,
            &root,
            &public_amount,
            &ext_data_hash,
            &nullifiers,
            &out_commitments,
        );
        Self::verify(&env, DataKey::TransferVerifier, &proof, &pi);
        Self::spend_nullifiers(&env, &nullifiers);
        for c in out_commitments.iter() {
            Self::record_commitment(&env, &c);
        }
        env.events().publish((symbol_short!("transfer"),), root);
    }

    /// Trustless withdraw at a corridor edge. The released token `amount` must
    /// equal the proof's verified `public_amount`, so the contract cannot be told
    /// to release more than the proof authorizes.
    pub fn withdraw(
        env: Env,
        proof: Groth16Proof,
        root: BytesN<32>,
        public_amount: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,
        out_commitments: Vec<BytesN<32>>,
        recipient: Address,
        amount: i128,
        offramp_symbol: Option<Symbol>,
        min_local_out: Option<i128>,
    ) {
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, PoolError::InvalidAmount);
        }
        // Bind the released amount to the verified public input. A withdraw has a
        // NEGATIVE publicAmount (value leaving the shielded set), so we bind to
        // the field-negative of `amount` — not the positive encoding.
        if public_amount != Self::neg_amount_bytes(&env, amount) {
            soroban_sdk::panic_with_error!(&env, PoolError::AmountNotBound);
        }
        Self::require_known_root(&env, &root);
        // Bind the RECIPIENT into the proof: the contract recomputes ext_data_hash
        // from (recipient, public_amount) instead of trusting a caller argument.
        // The withdraw proof was generated with exactly this hash, so an observer
        // cannot replay the same proof+nullifiers to a different recipient (the
        // recomputed hash would differ and the proof would fail to verify).
        let ext_data_hash = Self::ext_data_hash(&env, &recipient, &public_amount);
        let pi = Self::transfer_inputs(
            &env,
            &root,
            &public_amount,
            &ext_data_hash,
            &nullifiers,
            &out_commitments,
        );
        Self::verify(&env, DataKey::TransferVerifier, &proof, &pi);
        // Optional min-receive settlement gate. When the caller asks for off-ramp
        // slippage protection, the pool reads Reflector ON-CHAIN for the live local
        // rate and refuses to release if it would deliver less than `min_local_out`.
        // This makes the oracle LOAD-BEARING for fund movement, not just display.
        // It runs after proof verification but BEFORE nullifiers are spent, so a
        // withdraw rejected for too much slippage burns no nullifier and can be
        // retried when the rate recovers. Fail-closed: a stale/absent feed traps the
        // read into FxUnavailable here, so funds never move at an unknown rate.
        if let (Some(sym), Some(min_out)) = (offramp_symbol, min_local_out) {
            let usdc_whole = amount / USDC_STROOPS; // 7-dp SAC -> whole-USDC quote unit
                                                    // Settlement gate prices at the MEDIAN of recent records, not spot, so a
                                                    // transient oracle manipulation can't lower the floor and force a bad fill.
            let local = Self::quote_local_median(&env, sym, usdc_whole, FX_GATE_RECORDS);
            if local < min_out {
                soroban_sdk::panic_with_error!(&env, PoolError::SlippageExceeded);
            }
        }
        Self::spend_nullifiers(&env, &nullifiers);
        for c in out_commitments.iter() {
            Self::record_commitment(&env, &c);
        }
        Self::token(&env).transfer(&env.current_contract_address(), &recipient, &amount);
        env.events()
            .publish((symbol_short!("withdraw"), recipient), amount);
    }

    /// Verify a selective-disclosure proof for a regulator. The disclosed
    /// commitment must be one the pool actually knows.
    pub fn disclose(
        env: Env,
        proof: Groth16Proof,
        commitment: BytesN<32>,
        disclosed_amount: BytesN<32>,
        audit_context: BytesN<32>,
    ) -> bool {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Commitment(commitment.clone()))
        {
            soroban_sdk::panic_with_error!(&env, PoolError::UnknownCommitment);
        }
        let pi = vec![
            &env,
            Self::fr(&env, &commitment),
            Self::fr(&env, &disclosed_amount),
            Self::fr(&env, &audit_context),
        ];
        Self::verify(&env, DataKey::DisclosureVerifier, &proof, &pi);
        true
    }

    // ---- views ----
    pub fn current_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::CurrentRoot).unwrap()
    }
    pub fn is_root_known(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Root(root))
    }
    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }
    pub fn is_commitment_known(env: Env, commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Commitment(commitment))
    }
    pub fn commitment_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }
    /// Number of leaves in the Merkle tree (i.e. registered deposits).
    pub fn leaf_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::LeafCount)
            .unwrap_or(0)
    }
    /// The ordered Merkle-tree leaves (deposited commitments) from durable state.
    /// Lets any client reconstruct the exact tree without relying on event
    /// retention. Bounded by the tree capacity (2^depth).
    pub fn leaves(env: Env) -> Vec<BytesN<32>> {
        let n: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LeafCount)
            .unwrap_or(0);
        Self::leaf_range(env, 0, n)
    }
    /// Paginated leaves [start, start+count) — lets clients reconstruct large trees
    /// in bounded chunks (a single full `leaves()` would exceed the read budget at
    /// scale; the tree caps at 2^depth leaves).
    pub fn leaf_range(env: Env, start: u32, count: u32) -> Vec<BytesN<32>> {
        let n: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LeafCount)
            .unwrap_or(0);
        let end = core::cmp::min(start.saturating_add(count), n);
        let mut out = vec![&env];
        let mut i = start;
        while i < end {
            let leaf: BytesN<32> = env.storage().persistent().get(&DataKey::Leaf(i)).unwrap();
            out.push_back(leaf);
            i += 1;
        }
        out
    }
    pub fn balance(env: Env) -> i128 {
        Self::token(&env).balance(&env.current_contract_address())
    }

    // ---- internals ----
    fn token(env: &Env) -> TokenClient<'_> {
        let addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        TokenClient::new(env, &addr)
    }
    fn fr(_env: &Env, b: &BytesN<32>) -> Bn254Fr {
        Bn254Fr::from_bytes(b.clone())
    }

    /// 32-byte big-endian field-element encoding of a positive i128.
    fn amount_bytes(env: &Env, amount: i128) -> BytesN<32> {
        let mut buf = [0u8; 32];
        let be = amount.to_be_bytes(); // 16 bytes
        let mut i = 0;
        while i < 16 {
            buf[16 + i] = be[i];
            i += 1;
        }
        BytesN::from_array(env, &buf)
    }

    /// 32-byte big-endian encoding of (r - amount) where r is the BN254 scalar
    /// field modulus — i.e. the field-negative of a positive i128. A withdraw
    /// moves value OUT of the shielded set, so in the JoinSplit value equation
    /// `sum(in) + publicAmount == sum(out)` its publicAmount is negative. We bind
    /// the released token `amount` to that negative public input, so the proof's
    /// semantics (value leaving) match what the contract actually does.
    fn neg_amount_bytes(env: &Env, amount: i128) -> BytesN<32> {
        // r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
        const FIELD_R: [u8; 32] = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81,
            0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93,
            0xf0, 0x00, 0x00, 0x01,
        ];
        let amt = Self::amount_bytes(env, amount).to_array(); // [u8; 32] BE
        let mut out = [0u8; 32];
        let mut borrow: i16 = 0;
        let mut i = 31i32;
        while i >= 0 {
            let k = i as usize;
            let diff = FIELD_R[k] as i16 - amt[k] as i16 - borrow;
            if diff < 0 {
                out[k] = (diff + 256) as u8;
                borrow = 1;
            } else {
                out[k] = diff as u8;
                borrow = 0;
            }
            i -= 1;
        }
        BytesN::from_array(env, &out)
    }

    /// keccak256(recipient XDR || public_amount) — the ext-data binding used by
    /// `withdraw`. The browser builds the withdraw proof with this exact value, so
    /// the proof commits to the recipient and can't be replayed to another one.
    fn ext_data_hash(env: &Env, recipient: &Address, public_amount: &BytesN<32>) -> BytesN<32> {
        use soroban_sdk::xdr::ToXdr;
        let mut data = recipient.clone().to_xdr(env);
        data.extend_from_array(&public_amount.to_array());
        env.crypto().keccak256(&data).to_bytes()
    }

    /// field(addr) = keccak256(addr ScVal XDR) reduced mod r — the allow-list key
    /// for an account. The browser derives it identically, so the compliance
    /// proof's public sourceKey is pinned to the authenticated depositor.
    fn addr_field(env: &Env, addr: &Address) -> Bn254Fr {
        use soroban_sdk::xdr::ToXdr;
        let h = env.crypto().keccak256(&addr.clone().to_xdr(env));
        Bn254Fr::from_bytes(h.to_bytes())
    }

    fn transfer_inputs(
        env: &Env,
        root: &BytesN<32>,
        public_amount: &BytesN<32>,
        ext_data_hash: &BytesN<32>,
        nullifiers: &Vec<BytesN<32>>,
        out_commitments: &Vec<BytesN<32>>,
    ) -> Vec<Bn254Fr> {
        // Pin the input/output counts: the verifier sees only the flat vector, so an
        // unpinned split (e.g. 1 nullifier + 3 commitments) would verify the same proof
        // while spending one fewer nullifier -> double-spend. Both callers route through
        // here, so one guard covers transfer AND withdraw.
        if nullifiers.len() != TRANSFER_NINS || out_commitments.len() != TRANSFER_NOUTS {
            soroban_sdk::panic_with_error!(env, PoolError::BadIoCount);
        }
        let mut pi = vec![
            env,
            Self::fr(env, root),
            Self::fr(env, public_amount),
            Self::fr(env, ext_data_hash),
        ];
        for n in nullifiers.iter() {
            pi.push_back(Self::fr(env, &n));
        }
        for c in out_commitments.iter() {
            pi.push_back(Self::fr(env, &c));
        }
        pi
    }

    fn require_known_root(env: &Env, root: &BytesN<32>) {
        if !env.storage().persistent().has(&DataKey::Root(root.clone())) {
            soroban_sdk::panic_with_error!(env, PoolError::UnknownRoot);
        }
    }

    fn spend_nullifiers(env: &Env, nullifiers: &Vec<BytesN<32>>) {
        for n in nullifiers.iter() {
            let key = DataKey::Nullifier(n.clone());
            if env.storage().persistent().has(&key) {
                soroban_sdk::panic_with_error!(env, PoolError::NullifierUsed);
            }
            env.storage().persistent().set(&key, &());
            // Keep the spent marker alive as long as the roots/leaves it guards. On a
            // long-lived accumulator the leaves and roots are continually TTL-extended,
            // so a note stays provable indefinitely; if its nullifier were allowed to
            // expire and be archived, `has(&key)` would read false and the same note
            // could be spent again. Extend to match the root/leaf TTL.
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        }
    }

    fn record_commitment(env: &Env, commitment: &BytesN<32>) -> u32 {
        let key = DataKey::Commitment(commitment.clone());
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        if env.storage().persistent().has(&key) {
            return count; // already recorded — don't double-count
        }
        env.storage().persistent().set(&key, &());
        // Keep the commitment readable on a long-lived pool, so a deposit that hasn't
        // been registered into the tree yet can't have its backing record archived
        // out from under a later `register_root_verified`.
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        count
    }

    fn verify(env: &Env, which: DataKey, proof: &Groth16Proof, public_inputs: &Vec<Bn254Fr>) {
        let verifier: Address = env.storage().instance().get(&which).unwrap();
        // The Nethermind verifier TRAPS on an invalid proof, but we don't rely on
        // that: assert the returned bool too, so a verifier that returns `false`
        // (a common Groth16 convention) can never make a proof check a no-op.
        let ok: bool = env.invoke_contract(
            &verifier,
            &VERIFY,
            vec![env, proof.into_val(env), public_inputs.into_val(env)],
        );
        if !ok {
            soroban_sdk::panic_with_error!(env, PoolError::ProofRejected);
        }
    }
}

#[cfg(test)]
mod test;
