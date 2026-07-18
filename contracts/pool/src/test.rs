#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, Vec,
};

// Stub verifier that accepts every proof — lets us unit-test the pool's own
// logic (binding, nullifier set, commitment tracking, token custody).
#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify(_e: Env, _p: Groth16Proof, _pi: Vec<Bn254Fr>) -> bool {
        true
    }
}

// Stub Reflector SEP-40 oracle: USD-base feed reporting 1 unit = 0.05 USD scaled
// 10^14 (price 5e12), so 1 USD = 20 local units. Lets us unit-test offramp_quote's
// on-chain cross-contract read without the live network.
#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn lastprice(_e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: 5_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        })
    }
    // Last `n` records (newest first), all at the spot price — the median path the
    // settlement gate uses sees a stable 5e12 median, matching lastprice.
    pub fn prices(e: Env, _asset: Asset, n: u32) -> Option<Vec<PriceData>> {
        let mut v = vec![&e];
        let mut i = 0u32;
        while i < n {
            v.push_back(PriceData {
                price: 5_000_000_000_000i128,
                timestamp: 1_700_000_000u64,
            });
            i += 1;
        }
        Some(v)
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

// Oracle whose SPOT (lastprice) is a manipulated high outlier (100e12 -> a much
// smaller local quote) but whose recent history is mostly the honest 5e12. The median
// path must ignore the outlier and price at 5e12; a spot-based gate would not.
#[contract]
pub struct MockOracleOutlier;

#[contractimpl]
impl MockOracleOutlier {
    pub fn lastprice(_e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: 100_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        })
    }
    // 5 records: one manipulated outlier (100e12) + four honest (5e12). Sorted median
    // (index 2 of [5,5,5,5,100]e12) = 5e12 — the outlier can't move the floor.
    pub fn prices(e: Env, _asset: Asset, _n: u32) -> Option<Vec<PriceData>> {
        let mut v = vec![&e];
        v.push_back(PriceData {
            price: 100_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        });
        let mut i = 0u32;
        while i < 4 {
            v.push_back(PriceData {
                price: 5_000_000_000_000i128,
                timestamp: 1_700_000_000u64,
            });
            i += 1;
        }
        Some(v)
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

// Oracle whose feed is too thin for the gate (only 2 records < FX_MIN_RECORDS=3) —
// the median gate must fail closed rather than degrade to a near-spot read.
#[contract]
pub struct MockOracleThin;

#[contractimpl]
impl MockOracleThin {
    pub fn lastprice(_e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: 5_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        })
    }
    pub fn prices(e: Env, _asset: Asset, _n: u32) -> Option<Vec<PriceData>> {
        let mut v = vec![&e];
        v.push_back(PriceData {
            price: 5_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        });
        v.push_back(PriceData {
            price: 5_000_000_000_000i128,
            timestamp: 1_700_000_000u64,
        });
        Some(v) // only 2 < FX_MIN_RECORDS
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

// Oracle stub that carries NO price for any asset (lastprice -> None) — models a
// currency the feed doesn't support, so offramp_quote must return FxUnavailable.
#[contract]
pub struct MockOracleEmpty;

#[contractimpl]
impl MockOracleEmpty {
    pub fn lastprice(_e: Env, _asset: Asset) -> Option<PriceData> {
        None
    }
    pub fn prices(_e: Env, _asset: Asset, _n: u32) -> Option<Vec<PriceData>> {
        None
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

fn b32(env: &Env, k: u8) -> BytesN<32> {
    BytesN::from_array(env, &[k; 32])
}

// big-endian 32-byte encoding of a small integer (a valid BN254 field element).
fn b32_dec(env: &Env, n: u8) -> BytesN<32> {
    let mut a = [0u8; 32];
    a[31] = n;
    BytesN::from_array(env, &a)
}

// The on-chain Poseidon is bitwise-identical to circomlibjs poseidon([1,2]),
// so a contract-computed Merkle root equals the circuit/frontend root.
#[test]
fn poseidon_matches_circomlib() {
    let env = Env::default();
    let got = crate::poseidon::hash2(&env, &b32_dec(&env, 1), &b32_dec(&env, 2));
    // poseidon(1,2) = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a
    let want = BytesN::from_array(
        &env,
        &[
            0x11, 0x5c, 0xc0, 0xf5, 0xe7, 0xd6, 0x90, 0x41, 0x3d, 0xf6, 0x4c, 0x6b, 0x96, 0x62,
            0xe9, 0xcf, 0x2a, 0x36, 0x17, 0xf2, 0x74, 0x32, 0x45, 0x51, 0x9e, 0x19, 0x60, 0x7a,
            0x44, 0x17, 0x18, 0x9a,
        ],
    );
    assert_eq!(got, want);
}

// Diagnostic: measure the on-chain cost of Poseidon. One hash fits the per-tx
// CPU budget; ten (a depth-10 insert) do not — hence the merkleUpdate SNARK.
#[test]
fn poseidon_cost_probe() {
    let env = Env::default();
    let a = b32_dec(&env, 1);
    env.cost_estimate().budget().reset_unlimited();
    let _ = crate::poseidon::hash2(&env, &a, &a);
    std::println!(
        "[poseidon] ONE HASH cost:\n{:?}",
        env.cost_estimate().budget()
    );
    let mut z = BytesN::from_array(&env, &[0u8; 32]);
    env.cost_estimate().budget().reset_unlimited();
    for _ in 0..10 {
        z = crate::poseidon::hash2(&env, &z, &z);
    }
    std::println!(
        "[poseidon] TEN HASHES (depth-10 insert) cost:\n{:?}",
        env.cost_estimate().budget()
    );
}

fn amt_bytes(env: &Env, amount: i128) -> BytesN<32> {
    let mut buf = [0u8; 32];
    let be = amount.to_be_bytes();
    for i in 0..16 {
        buf[16 + i] = be[i];
    }
    BytesN::from_array(env, &buf)
}

// Field-negative of `amount` (r - amount), BE — the publicAmount convention a
// real withdraw proof carries (value leaving the shielded set).
fn neg_amt_bytes(env: &Env, amount: i128) -> BytesN<32> {
    const FIELD_R: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
        0x00, 0x01,
    ];
    let amt = amt_bytes(env, amount).to_array();
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

fn dummy_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: Bn254G1Affine::from_bytes(BytesN::from_array(env, &[0u8; 64])),
        b: Bn254G2Affine::from_bytes(BytesN::from_array(env, &[0u8; 128])),
        c: Bn254G1Affine::from_bytes(BytesN::from_array(env, &[0u8; 64])),
    }
}

struct Ctx {
    pool: PoolClient<'static>,
    token: TokenClient<'static>,
    user: Address,
}

fn setup(env: &Env) -> Ctx {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let v = env.register(MockVerifier, ());
    let oracle = env.register(MockOracle, ());
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    StellarAssetClient::new(env, &token_addr).mint(&user, &1_000);

    let deny: Vec<BytesN<32>> = vec![env, b32(env, 91), b32(env, 92), b32(env, 93), b32(env, 94)];
    let id = env.register(
        Pool,
        (
            admin,
            token_addr.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),     // update verifier
            b32(env, 0),   // initial_root
            b32(env, 100), // asp_root
            deny,
            oracle, // fx_oracle (Reflector stub)
        ),
    );
    Ctx {
        pool: PoolClient::new(env, &id),
        token: TokenClient::new(env, &token_addr),
        user,
    }
}

// The pool computes the off-ramp figure ON-CHAIN by reading the Reflector oracle
// (contract-to-contract). With the stub feed (1 USD = 20 local), 100 USDC -> 2000.
#[test]
fn offramp_quote_reads_oracle_on_chain() {
    let env = Env::default();
    let c = setup(&env);
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    assert_eq!(c.pool.offramp_quote(&sym, &100), 2000);
    assert_eq!(c.pool.offramp_quote(&sym, &500), 10000);
    assert_eq!(c.pool.offramp_quote(&sym, &0), 0); // zero quote is well-defined
}

// A currency the oracle doesn't carry (lastprice -> None) -> FxUnavailable, not a trap.
#[test]
#[should_panic(expected = "Error(Contract, #11)")] // FxUnavailable
fn offramp_quote_unsupported_currency_rejected() {
    let env = Env::default();
    let c = setup(&env);
    let empty = env.register(MockOracleEmpty, ());
    c.pool.set_fx_oracle(&empty); // admin (mocked auth) repoints to the empty feed
    let sym = soroban_sdk::Symbol::new(&env, "JPY");
    c.pool.offramp_quote(&sym, &100);
}

// Negative quote input is rejected (bounds match deposit's 64-bit range).
#[test]
#[should_panic(expected = "Error(Contract, #5)")] // InvalidAmount
fn offramp_quote_rejects_negative_amount() {
    let env = Env::default();
    let c = setup(&env);
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.offramp_quote(&sym, &-1);
}

// set_fx_oracle updates the address the quote reads, and fx_oracle() reflects it.
#[test]
fn set_fx_oracle_updates_view() {
    let env = Env::default();
    let c = setup(&env);
    let other = env.register(MockOracleEmpty, ());
    c.pool.set_fx_oracle(&other);
    assert_eq!(c.pool.fx_oracle(), other);
}

// Configurable compliance policy (mirrors Confidential Tokens' policy engine):
// set_asp_root / set_deny_list update the live policy the compliance check reads,
// and the views reflect it — so policy can change without redeploying the pool.
#[test]
fn set_asp_root_updates_view() {
    let env = Env::default();
    let c = setup(&env);
    assert_eq!(c.pool.asp_root(), b32(&env, 100)); // constructor value
    c.pool.set_asp_root(&b32(&env, 77));
    assert_eq!(c.pool.asp_root(), b32(&env, 77));
}

#[test]
fn set_deny_list_updates_view() {
    let env = Env::default();
    let c = setup(&env);
    let new: Vec<BytesN<32>> = vec![
        &env,
        b32(&env, 81),
        b32(&env, 82),
        b32(&env, 83),
        b32(&env, 84),
    ];
    c.pool.set_deny_list(&new);
    assert_eq!(c.pool.deny_list(), new);
}

#[test]
#[should_panic]
fn set_deny_list_rejects_wrong_len() {
    let env = Env::default();
    let c = setup(&env);
    // 3 entries != DENY_LEN (4) — must reject so the deny-list always matches the
    // circuit's fixed public-input count.
    let bad: Vec<BytesN<32>> = vec![&env, b32(&env, 81), b32(&env, 82), b32(&env, 83)];
    c.pool.set_deny_list(&bad);
}

#[test]
fn deposit_pulls_tokens_and_records_commitment() {
    let env = Env::default();
    let c = setup(&env);
    let commit = b32(&env, 1);
    assert_eq!(
        c.pool.deposit(
            &c.user,
            &300,
            &commit,
            &dummy_proof(&env),
            &dummy_proof(&env)
        ),
        0
    );
    assert_eq!(c.pool.balance(), 300); // tokens now custodied by the pool
    assert_eq!(c.token.balance(&c.user), 700);
    assert!(c.pool.is_commitment_known(&commit));
}

// A second deposit to the SAME commitment would lock tokens (it can never become a
// second spendable leaf), so it's rejected before any tokens move.
#[test]
#[should_panic(expected = "Error(Contract, #10)")] // DuplicateCommitment
fn deposit_rejects_duplicate_commitment() {
    let env = Env::default();
    let c = setup(&env);
    let commit = b32(&env, 1);
    c.pool.deposit(
        &c.user,
        &100,
        &commit,
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    c.pool.deposit(
        &c.user,
        &100,
        &commit,
        &dummy_proof(&env),
        &dummy_proof(&env),
    ); // dup -> #10
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // InvalidAmount
fn deposit_rejects_amount_over_64_bits() {
    let env = Env::default();
    let c = setup(&env);
    // 2^64 stroops can't fit the disclosure circuit's 64-bit range — rejected early.
    c.pool.deposit(
        &c.user,
        &(1i128 << 64),
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
}

#[test]
fn withdraw_releases_bound_amount() {
    let env = Env::default();
    let c = setup(&env);
    c.pool.deposit(
        &c.user,
        &300,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );

    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    // public_amount must equal the field-negative of the released amount (binding)
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, 120),
        &nulls,
        &outs,
        &recipient,
        &120,
        &None,
        &None,
    );
    assert_eq!(c.token.balance(&recipient), 120);
    assert_eq!(c.pool.balance(), 180);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // AmountNotBound
fn withdraw_amount_must_match_public_amount() {
    let env = Env::default();
    let c = setup(&env);
    c.pool.deposit(
        &c.user,
        &300,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    // public_amount binds to 50 but caller tries to release 120 -> rejected
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, 50),
        &nulls,
        &outs,
        &recipient,
        &120,
        &None,
        &None,
    );
}

// The min-receive settlement gate: when a withdraw asks for off-ramp slippage
// protection, the pool reads Reflector ON-CHAIN and only releases if the live local
// amount meets the floor. With the stub feed (1 USD = 20 local), a 2-USDC withdraw
// quotes 40 local: a 40 floor passes, a 41 floor is rejected (SlippageExceeded).
#[test]
fn withdraw_oracle_gate_passes_when_rate_meets_floor() {
    let env = Env::default();
    let c = setup(&env);
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128; // 2 whole USDC in 7-dp stroops
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(40),
    );
    assert_eq!(c.token.balance(&recipient), two_usdc); // released: live rate met the floor
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // SlippageExceeded
fn withdraw_oracle_gate_rejects_below_floor() {
    let env = Env::default();
    let c = setup(&env);
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128;
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    // quote is 40 local; demanding 41 must reject and release nothing.
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(41),
    );
}

// Fail-closed on a STALE feed too: a frozen-but-positive price (older than the
// pool's freshness bound) must not be used as a live rate. The mock prices are
// stamped at 1_700_000_000; advancing the ledger clock 2h past that makes the feed
// stale, so a gated withdraw aborts with FxUnavailable rather than settling at a
// stale rate. (Guards against the "fail-closed" claim being true only for absent feeds.)
#[test]
#[should_panic(expected = "Error(Contract, #11)")] // FxUnavailable (stale)
fn withdraw_oracle_gate_rejects_stale_feed() {
    let env = Env::default();
    let c = setup(&env);
    env.ledger().set_timestamp(1_700_000_000 + 7200); // 2h after the mock price stamp > 3600s bound
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128;
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(1),
    );
}

// Fail-closed: if the gate is requested but the feed can't price the currency
// (lastprice -> None), the withdraw aborts (FxUnavailable) rather than releasing
// funds at an unknown rate. The nullifier is NOT spent, so it stays retryable.
#[test]
#[should_panic(expected = "Error(Contract, #11)")] // FxUnavailable
fn withdraw_oracle_gate_fails_closed_on_dead_feed() {
    let env = Env::default();
    let c = setup(&env);
    let empty = env.register(MockOracleEmpty, ());
    c.pool.set_fx_oracle(&empty);
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128;
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(1),
    );
}

// OUT-OF-THE-BOX (audit round 9): the settlement gate prices at the MEDIAN of recent
// records, not spot. Here the oracle's SPOT (lastprice) is a manipulated high outlier
// (100e12 -> only ~2 local for 2 USDC, which would FAIL a 40 floor), but the median of
// its recent records is the honest 5e12 -> 40 local -> the legit withdraw PASSES. A
// spot-based gate would have wrongly rejected; the median gate ignores the outlier.
#[test]
fn withdraw_oracle_gate_median_ignores_spot_outlier() {
    let env = Env::default();
    let c = setup(&env);
    let outlier = env.register(MockOracleOutlier, ());
    c.pool.set_fx_oracle(&outlier);
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128;
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(40),
    );
    assert_eq!(c.token.balance(&recipient), two_usdc); // released: median (5e12) met the 40 floor
}

// Thin feed (fewer than FX_MIN_RECORDS records) -> the median gate fails closed
// (FxUnavailable) rather than degrading to a near-spot read on too little data.
#[test]
#[should_panic(expected = "Error(Contract, #11)")] // FxUnavailable
fn withdraw_oracle_gate_rejects_thin_feed() {
    let env = Env::default();
    let c = setup(&env);
    let thin = env.register(MockOracleThin, ());
    c.pool.set_fx_oracle(&thin);
    StellarAssetClient::new(&env, &c.token.address).mint(&c.user, &30_000_000);
    let two_usdc = 20_000_000i128;
    c.pool.deposit(
        &c.user,
        &two_usdc,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, two_usdc),
        &nulls,
        &outs,
        &recipient,
        &two_usdc,
        &Some(sym),
        &Some(1),
    );
}

// The public median view the frontend uses for its floor: with the stub feed
// (1 USD = 20 local) the median of identical records gives the same 2000 for 100 USDC.
#[test]
fn offramp_quote_twap_reads_median_on_chain() {
    let env = Env::default();
    let c = setup(&env);
    let sym = soroban_sdk::Symbol::new(&env, "MXN");
    assert_eq!(c.pool.offramp_quote_twap(&sym, &100, &5), 2000);
}

// CRITICAL regression (audit round 7): the Groth16 verifier sees only a FLAT public-
// input vector, so the contract must pin how many entries are nullifiers vs.
// commitments. A 2-in/2-out proof's vector [root,pa,edh, n0,n1, o0,o1] is byte-identical
// whether split (2 nullifiers, 2 commitments) or (1 nullifier, 3 commitments) — so the
// SAME proof verifies, but `spend_nullifiers` would then burn only n0, leaving n1
// unspent and double-spendable. Pinning the counts rejects the malformed split.
#[test]
#[should_panic(expected = "Error(Contract, #13)")] // BadIoCount
fn transfer_rejects_shifted_io_split() {
    let env = Env::default();
    let c = setup(&env);
    // attacker shifts a nullifier (n1=b32(11)) into the commitments segment: 1 + 3
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 11), b32(&env, 20), b32(&env, 21)];
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 0),
        &b32(&env, 0),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")] // BadIoCount
fn withdraw_rejects_shifted_io_split() {
    let env = Env::default();
    let c = setup(&env);
    c.pool.deposit(
        &c.user,
        &300,
        &b32(&env, 1),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    let recipient = Address::generate(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 11), b32(&env, 20), b32(&env, 21)];
    c.pool.withdraw(
        &dummy_proof(&env),
        &b32(&env, 0),
        &neg_amt_bytes(&env, 120),
        &nulls,
        &outs,
        &recipient,
        &120,
        &None,
        &None,
    );
}

#[test]
fn transfer_spends_nullifiers_and_records_outputs() {
    let env = Env::default();
    let c = setup(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 0),
        &b32(&env, 0),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
    assert!(c.pool.is_nullifier_used(&b32(&env, 10)));
    assert!(c.pool.is_commitment_known(&b32(&env, 20)));
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NullifierUsed
fn transfer_double_spend_rejected() {
    let env = Env::default();
    let c = setup(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 0),
        &b32(&env, 0),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 0),
        &b32(&env, 0),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // UnknownRoot
fn transfer_unknown_root_rejected() {
    let env = Env::default();
    let c = setup(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 250),
        &b32(&env, 0),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
}

// A pure shielded transfer must move zero external value. A positive public_amount
// with zero-value dummy inputs would otherwise MINT a backed commitment from nothing
// (the circuit only enforces sumIn + publicAmount == sumOut, and dummy inputs skip
// the Merkle check). The contract must reject any non-zero public_amount on transfer.
#[test]
#[should_panic(expected = "Error(Contract, #6)")] // AmountNotBound
fn transfer_rejects_nonzero_public_amount() {
    let env = Env::default();
    let c = setup(&env);
    let nulls: Vec<BytesN<32>> = vec![&env, b32(&env, 10), b32(&env, 11)];
    let outs: Vec<BytesN<32>> = vec![&env, b32(&env, 20), b32(&env, 21)];
    // root 0 is the known genesis; public_amount = 5 (non-zero) must be rejected.
    c.pool.transfer(
        &dummy_proof(&env),
        &b32(&env, 0),
        &b32(&env, 5),
        &b32(&env, 5),
        &nulls,
        &outs,
    );
}

#[test]
fn disclose_requires_known_commitment() {
    let env = Env::default();
    let c = setup(&env);
    let commit = b32(&env, 1);
    c.pool.deposit(
        &c.user,
        &100,
        &commit,
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    assert!(c
        .pool
        .disclose(&dummy_proof(&env), &commit, &b32(&env, 50), &b32(&env, 42)));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // UnknownCommitment
fn disclose_unknown_commitment_rejected() {
    let env = Env::default();
    let c = setup(&env);
    c.pool.disclose(
        &dummy_proof(&env),
        &b32(&env, 200),
        &b32(&env, 50),
        &b32(&env, 42),
    );
}

#[test]
fn register_root_verified_advances_from_known_root() {
    let env = Env::default();
    let c = setup(&env);
    let old = b32(&env, 0); // known initial root
    let leaf = b32(&env, 42);
    let newr = b32(&env, 77);
    assert!(!c.pool.is_root_known(&newr));
    // The leaf must be a backed commitment first (a real deposit moved tokens in).
    c.pool
        .deposit(&c.user, &10, &leaf, &dummy_proof(&env), &dummy_proof(&env));
    c.pool
        .register_root_verified(&dummy_proof(&env), &old, &leaf, &newr);
    assert!(c.pool.is_root_known(&newr));
    assert_eq!(c.pool.current_root(), newr);
    assert!(c.pool.is_commitment_known(&leaf));
}

// THE DRAIN DEFENSE: a leaf that was never deposited cannot be inserted into the
// spendable tree — so an attacker can't mint a note out of thin air and withdraw
// against it. Without this gate `register_root_verified` would accept any leaf.
#[test]
#[should_panic(expected = "Error(Contract, #3)")] // UnknownCommitment
fn register_root_verified_rejects_undeposited_leaf() {
    let env = Env::default();
    let c = setup(&env);
    let old = b32(&env, 0);
    // leaf 200 was never deposited (no tokens backing it) -> rejected.
    c.pool
        .register_root_verified(&dummy_proof(&env), &old, &b32(&env, 200), &b32(&env, 77));
}

// Insert-once: the SAME backed commitment cannot be inserted twice (a second
// spendable leaf with a different nullifier would double the deposit's value).
#[test]
#[should_panic(expected = "Error(Contract, #9)")] // LeafAlreadyInserted
fn register_root_verified_rejects_double_insert() {
    let env = Env::default();
    let c = setup(&env);
    let leaf = b32(&env, 42);
    c.pool
        .deposit(&c.user, &10, &leaf, &dummy_proof(&env), &dummy_proof(&env));
    let g = c.pool.current_root();
    c.pool
        .register_root_verified(&dummy_proof(&env), &g, &leaf, &b32(&env, 77));
    // try to insert the very same commitment again from the new current root
    let r1 = c.pool.current_root();
    c.pool
        .register_root_verified(&dummy_proof(&env), &r1, &leaf, &b32(&env, 88));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // UnknownRoot
fn register_root_verified_rejects_unknown_old_root() {
    let env = Env::default();
    let c = setup(&env);
    c.pool.register_root_verified(
        &dummy_proof(&env),
        &b32(&env, 250),
        &b32(&env, 42),
        &b32(&env, 77),
    );
}

// Accumulator semantics: an insert must build on the CURRENT root. Inserting from
// a now-stale (formerly-current) root is rejected, so the tree is a single global
// accumulator and its reconstructed root always equals current_root.
#[test]
#[should_panic(expected = "Error(Contract, #1)")] // UnknownRoot
fn register_root_verified_rejects_stale_root() {
    let env = Env::default();
    let c = setup(&env);
    let genesis = c.pool.current_root();
    c.pool.deposit(
        &c.user,
        &10,
        &b32(&env, 42),
        &dummy_proof(&env),
        &dummy_proof(&env),
    );
    c.pool
        .register_root_verified(&dummy_proof(&env), &genesis, &b32(&env, 42), &b32(&env, 77));
    // current_root is now 77; inserting again from the stale genesis must fail
    // (this fails on the stale root before the leaf-backing check is reached).
    c.pool
        .register_root_verified(&dummy_proof(&env), &genesis, &b32(&env, 43), &b32(&env, 88));
}

// Leaves are stored on-chain in order, so a client can reconstruct the exact tree
// from contract state (leaves()) without relying on event retention.
#[test]
fn register_root_verified_stores_ordered_leaves() {
    let env = Env::default();
    let c = setup(&env);
    assert_eq!(c.pool.leaf_count(), 0);
    let g = c.pool.current_root();
    let l0 = b32(&env, 42);
    let l1 = b32(&env, 43);
    c.pool
        .deposit(&c.user, &10, &l0, &dummy_proof(&env), &dummy_proof(&env));
    c.pool
        .deposit(&c.user, &10, &l1, &dummy_proof(&env), &dummy_proof(&env));
    c.pool
        .register_root_verified(&dummy_proof(&env), &g, &l0, &b32(&env, 77));
    let r1 = c.pool.current_root(); // accumulator: next insert builds on this
    c.pool
        .register_root_verified(&dummy_proof(&env), &r1, &l1, &b32(&env, 88));
    assert_eq!(c.pool.leaf_count(), 2);
    let ls = c.pool.leaves();
    assert_eq!(ls.len(), 2);
    assert_eq!(ls.get(0).unwrap(), l0);
    assert_eq!(ls.get(1).unwrap(), l1);
}

// leaf_range returns bounded chunks (for reconstructing large trees) and clamps.
#[test]
fn leaf_range_paginates_and_clamps() {
    let env = Env::default();
    let c = setup(&env);
    let mut cur = c.pool.current_root();
    let mut k = 0u8;
    while k < 3 {
        let leaf = b32(&env, 50 + k);
        let nr = b32(&env, 70 + k);
        c.pool
            .deposit(&c.user, &10, &leaf, &dummy_proof(&env), &dummy_proof(&env));
        c.pool
            .register_root_verified(&dummy_proof(&env), &cur, &leaf, &nr);
        cur = nr;
        k += 1;
    }
    assert_eq!(c.pool.leaf_count(), 3);
    let mid = c.pool.leaf_range(&1, &1);
    assert_eq!(mid.len(), 1);
    assert_eq!(mid.get(0).unwrap(), b32(&env, 51));
    let tail = c.pool.leaf_range(&2, &99); // count past the end is clamped
    assert_eq!(tail.len(), 1);
    assert_eq!(tail.get(0).unwrap(), b32(&env, 52));
}
