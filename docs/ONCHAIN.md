# On-Chain Verification (Stellar testnet)

How Tukar verifies a Groth16 proof inside a Soroban smart contract using
Stellar's native BN254 host functions (Protocol 25 "X-Ray" / 26 "Yardstick").

The verifier contract pattern is adapted from Nethermind's
`circom-groth16-verifier` (verifies over **BN254** via `env.crypto().bn254()`,
matching snarkjs/circom's default curve — no curve re-targeting needed).

## Pipeline

```
circuits/disclosure.circom
   │  circom + snarkjs (scripts/build-disclosure.sh)
   ▼
circuits/build/verification_key.json   circuits/build/proof.json + public.json
   │ (embedded at compile time)          │ (converted to contract args)
   ▼                                      ▼
contracts/build/circom_groth16_verifier.wasm  ──deploy──►  Soroban (testnet)
                                                              │
                                          invoke verify(proof, public_inputs)
                                                              ▼
                                                          true / error
```

## 1. Build the verifier with Tukar's VK

The VK is baked into the WASM at compile time via the crate's `build.rs`
(`VERIFIER_VK_JSON` env var). The verifier crate itself comes from Nethermind's
reference, so **clone it first** (it is gitignored in this repo):

```bash
git clone https://github.com/NethermindEth/stellar-private-payments \
  _reference/stellar-private-payments
```

Then build against that workspace (works natively on macOS/Linux; on Windows use
WSL — the MSVC linker can't produce the wasm32 target):

```bash
cd _reference/stellar-private-payments
VERIFIER_VK_JSON="$PWD/../../circuits/build/verification_key.json" \
  stellar contract build \
    --package circom-groth16-verifier \
    --out-dir ../../contracts/build
```

Output: `contracts/build/circom_groth16_verifier.wasm`. Repeat once per circuit
(`transfer_vk.json`, `compliance_vk.json`, `merkleUpdate_vk.json`), renaming the
output between runs — see `scripts/wsl-build-verifier.sh` (name is historical;
it runs fine outside WSL too).

## 2. Testnet identity

```bash
stellar keys generate corredor2 --network testnet --fund
stellar keys address corredor2
# GA2DZZWGTZ4NGGNM3FQERYXLCHXQ2XXRC7OCHUFCXDC5D4HLEYFF4IWM
```

## 3. Deploy

```bash
stellar contract deploy \
  --wasm contracts/build/circom_groth16_verifier.wasm \
  --source corredor2 --network testnet
# -> CONTRACT_ID
```

## 4. Convert snarkjs proof → contract args

The contract's `verify(proof: Groth16Proof, public_inputs: Vec<Bn254Fr>)` expects:

- **proof**: `A (G1, 64B) || B (G2, 128B) || C (G1, 64B)` = 256 bytes.
  **Important:** Soroban G2 points use **c1||c0 (imaginary||real)** byte ordering,
  while snarkjs `proof.json` lists Fq2 as `[c0, c1]`. The converter must swap the
  two Fq2 components for each G2 coordinate, and serialize each Fq as 32-byte
  big-endian.
- **public_inputs**: the three public signals from `public.json`
  (`commitment`, `disclosedAmount`, `auditContextHash`) as `Bn254Fr` (32B BE each).

A small converter (`scripts/proof-to-soroban.mjs`) emits the hex args. Then:

```bash
stellar contract invoke --id CONTRACT_ID \
  --source corredor2 --network testnet -- \
  verify --proof <hex-256B> --public_inputs '[<fr0>,<fr1>,<fr2>]'
```

Expected result: `true` — the regulator's disclosure proof is verified on-chain
without revealing any private salary/amount detail.

## Status — ✅ VERIFIED ON TESTNET

- [x] Verifier WASM build with Tukar VK (4685 bytes, exports `verify`)
- [x] Deployed to testnet — contract `CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET`
  ([deploy tx](https://stellar.expert/explorer/testnet/tx/5acd8533c17bcaff5fb90957620b9a6a36b6afa8d13b04f14976bf80130129d3))
- [x] Proof → Soroban arg converter (`scripts/gen-invoke-args.mjs`, G2 c1‖c0 swap)
- [x] Invoke `verify` with valid proof → **`true`** (verified live via simulation against a fresh sample proof)
- [x] Negative test: tampered public input → **rejected** on-chain (`InvalidProof`)

All artifacts and tx hashes recorded in [`deployments/testnet.json`](../deployments/testnet.json).

### Reproduce

```bash
npm run circuit:disclosure                       # compile + prove (off-chain)
node scripts/gen-invoke-args.mjs                 # snarkjs proof -> CLI args
stellar contract invoke \
  --id CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET \
  --source corredor2 --network testnet -- verify \
  --proof-file-path circuits/build/soroban_proof.json \
  --public_inputs-file-path circuits/build/soroban_public.json
# -> true
```
