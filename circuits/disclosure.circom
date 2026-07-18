pragma circom 2.1.6;

// Tukar — Selective Disclosure circuit
// -----------------------------------------------------------------------------
// The compliance wedge of Tukar. A confidential payment in the corridor is
// represented on-chain only by a commitment:
//     commitment = Poseidon(amount, pubKey, blinding)
// The amount and counterparties are hidden. With this circuit the holder can
// hand a REGULATOR a zero-knowledge proof that selectively discloses exactly one
// fact about the payment — its amount — and nothing else, bound to a specific
// audit request so the proof cannot be replayed for a different audit.
//
// This is "compliant privacy": the public sees nothing, the regulator learns
// only what they are entitled to, and the holder proves it without revealing
// keys, blinding, or any other payment in the graph.
//
// Public  inputs : commitment, disclosedAmount, auditContextHash
// Private inputs : amount, pubKey, blinding
// -----------------------------------------------------------------------------

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

template Disclosure() {
    // ---- PUBLIC INPUTS ----
    signal input commitment;          // the on-chain confidential commitment
    signal input disclosedAmount;     // the amount being revealed to the regulator
    signal input auditContextHash;    // binds proof to one audit request (period, regulator id)

    // ---- PRIVATE INPUTS (holder secrets) ----
    signal input amount;              // true amount inside the commitment
    signal input pubKey;              // owner public key
    signal input blinding;            // commitment randomness

    // 1. Re-open the commitment from its secret preimage.
    component hasher = Poseidon(3);
    hasher.inputs[0] <== amount;
    hasher.inputs[1] <== pubKey;
    hasher.inputs[2] <== blinding;
    commitment === hasher.out;

    // 2. The disclosed amount must equal the true hidden amount.
    disclosedAmount === amount;

    // 3. Range-check the amount to 64 bits (no field-wrap shenanigans; ample for
    //    any USDC amount in stroops).
    component range = Num2Bits(64);
    range.in <== amount;

    // 4. Bind the audit context so a disclosure for one request cannot be
    //    replayed for another.
    signal ctxSq;
    ctxSq <== auditContextHash * auditContextHash;
}

component main { public [ commitment, disclosedAmount, auditContextHash ] } = Disclosure();
