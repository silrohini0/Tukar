// Generates a sample input.json for the disclosure circuit.
// Computes the Poseidon commitment off-chain exactly as the circuit does,
// so the proof opens a valid commitment to a disclosed amount.
import { buildPoseidon } from "circomlibjs";

// A confidential payment of 5.0000000 USDC (7 decimals -> stroops).
const amount = 50000000n;
const pubKey = 1234567890123456789n;       // employee/receiver public key (field element)
const blinding = 9876543210987654321n;     // commitment randomness
const auditContextHash = 42n;              // identifies one audit request (regulator + period)

const poseidon = await buildPoseidon();
const F = poseidon.F;
const commitment = F.toString(poseidon([amount, pubKey, blinding]));

const input = {
  // public
  commitment,
  disclosedAmount: amount.toString(),
  auditContextHash: auditContextHash.toString(),
  // private
  amount: amount.toString(),
  pubKey: pubKey.toString(),
  blinding: blinding.toString(),
};

console.log(JSON.stringify(input, null, 2));
