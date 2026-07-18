//! circomlib-compatible Poseidon (t=3, two inputs) over the BN254 scalar field,
//! computed ON-CHAIN with Soroban's host-accelerated field arithmetic
//! (`Bn254Fr` add/mul/pow). Bitwise-identical to circomlibjs `poseidon([a,b])`,
//! so the on-chain Merkle root equals the one the circuits/frontend compute.
//!
//! Algorithm mirrors circomlibjs `poseidon_reference.js`:
//!   t = 3, nRoundsF = 8, nRoundsP = 57 (full rounds at r in [0,4) and [61,65)).
//!   per round: add round constants C, S-box x^5 (all lanes on full rounds, lane 0
//!   on partial rounds), then MDS mix  new[i] = Σ_j M[i][j]·state[j].
use soroban_sdk::crypto::bn254::Bn254Fr;
use soroban_sdk::{BytesN, Env, U256};

use crate::poseidon_constants::{POSEIDON_C, POSEIDON_M};

const N_ROUNDS_F: usize = 8;
const N_ROUNDS_P: usize = 57;

#[inline]
fn fr(env: &Env, b: &[u8; 32]) -> Bn254Fr {
    Bn254Fr::from_bytes(BytesN::from_array(env, b))
}

#[inline]
fn zero(env: &Env) -> Bn254Fr {
    Bn254Fr::from_u256(U256::from_u32(env, 0))
}

/// Poseidon hash of two BN254 field elements.
pub fn poseidon2(env: &Env, a: Bn254Fr, b: Bn254Fr) -> Bn254Fr {
    let mut state = [zero(env), a, b];
    let rounds = N_ROUNDS_F + N_ROUNDS_P; // 65
    let half_f = N_ROUNDS_F / 2; // 4
    for r in 0..rounds {
        // --- add round constants ---
        let base = r * 3;
        state[0] = state[0].clone() + fr(env, &POSEIDON_C[base]);
        state[1] = state[1].clone() + fr(env, &POSEIDON_C[base + 1]);
        state[2] = state[2].clone() + fr(env, &POSEIDON_C[base + 2]);

        // --- S-box x^5 ---
        let full = r < half_f || r >= half_f + N_ROUNDS_P;
        state[0] = state[0].pow(5);
        if full {
            state[1] = state[1].pow(5);
            state[2] = state[2].pow(5);
        }

        // --- MDS mix: new[i] = Σ_j M[i][j]·state[j] ---
        let s0 = state[0].clone();
        let s1 = state[1].clone();
        let s2 = state[2].clone();
        let mut ns = [zero(env), zero(env), zero(env)];
        for i in 0..3 {
            let m = &POSEIDON_M[i];
            ns[i] = fr(env, &m[0]) * s0.clone()
                + fr(env, &m[1]) * s1.clone()
                + fr(env, &m[2]) * s2.clone();
        }
        state = ns;
    }
    let [out, _, _] = state;
    out
}

/// Poseidon over the 32-byte big-endian encodings used everywhere else.
pub fn hash2(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    poseidon2(
        env,
        Bn254Fr::from_bytes(a.clone()),
        Bn254Fr::from_bytes(b.clone()),
    )
    .to_bytes()
}
