# Tukar

Tukar is a confidential cross-border payment corridor built on Stellar Soroban.
It models a real remittance flow:

```text
fiat on-ramp -> USDC deposit -> private shielded transfer -> USDC withdraw -> fiat off-ramp
```

Deposits and withdrawals stay public at the corridor edges, because real assets
enter and leave custody there. The middle of the corridor is private: amounts,
spenders, recipients, and note ownership are hidden behind zero-knowledge proofs.
Compliance is handled with allow-list and deny-list proofs, plus selective
disclosure for audits.

This repository contains:

- Soroban smart contracts for custody, Merkle root management, nullifier tracking,
  oracle reads, and verifier orchestration.
- Circom/Groth16 circuits for transfer, compliance, disclosure, and trustless
  Merkle tree updates.
- A browser demo that generates proofs client-side and reads/writes Stellar
  testnet state.
- A Next.js wallet app for Freighter-based Stellar interactions.
- CI/CD workflow, deployment script, test suites, and production-readiness notes.

## Features

- Real Stellar testnet deployment with recorded contract IDs and transaction hashes.
- Token custody through a Stellar Asset Contract.
- Inter-contract calls from the pool to Groth16 verifier contracts.
- Cross-contract FX reads from Reflector's SEP-40 oracle.
- Event stream for `deposit`, `withdraw`, `transfer`, and `root` activity.
- Durable Merkle tree reconstruction through on-chain `leaf_count` and `leaf_range`.
- Client-side proof generation with browser WASM artifacts.
- Freighter wallet support with fallback testnet demo key.
- Loading states, route persistence, transaction feedback, and graceful error handling.
- Unit, integration, contract, and browser routing tests.
- GitHub Actions workflow for linting, type checks, tests, build, and artifacts.

## Architecture

```text
                           +-----------------------------+
                           |        Browser UI           |
                           |  proof generation + wallet  |
                           +--------------+--------------+
                                          |
                                          | Soroban RPC
                                          |
+-------------------+       +-------------v--------------+
| Reflector FX      |<------+        Pool Contract       |
| SEP-40 Oracle     |       | custody + state machine    |
+-------------------+       +------+------+------+-------+
                                   |      |      |
                                   |      |      |
                     +-------------+      |      +--------------+
                     |                    |                     |
          +----------v----------+ +-------v--------+ +----------v----------+
          | Transfer Verifier   | | Compliance     | | Disclosure Verifier |
          | JoinSplit proof     | | Verifier       | | audit proof         |
          +---------------------+ +-------+--------+ +---------------------+
                                          |
                                 +--------v---------+
                                 | Merkle Update    |
                                 | Verifier         |
                                 +------------------+
```

### Flow

1. A sender enters an amount and destination corridor in the frontend.
2. The browser creates a commitment and generates compliance and amount-binding
   proofs.
3. `pool.deposit` verifies the proofs, pulls USDC into custody, records the
   commitment, and emits a deposit event.
4. `pool.register_root_verified` advances the Merkle root only after a valid
   `merkleUpdate` proof.
5. A shielded transfer spends nullifiers and creates new output commitments.
6. `pool.withdraw` verifies the transfer proof, checks the root and nullifiers,
   optionally checks an on-chain FX floor, releases USDC, and emits a withdraw
   event.
7. A regulator can verify a selective-disclosure proof for a known commitment
   without learning the rest of the private payment graph.

## Smart Contracts

### Pool Contract

Source: [`contracts/pool/src/lib.rs`](contracts/pool/src/lib.rs)

The pool is the main stateful contract. It is responsible for:

- Holding the custodied token address.
- Storing verifier contract addresses.
- Storing admin-controlled compliance policy roots.
- Tracking known Merkle roots.
- Tracking spent nullifiers.
- Tracking known commitments and ordered Merkle leaves.
- Verifying proofs through separate verifier contracts.
- Moving USDC in and out through the Stellar Asset Contract.
- Reading Reflector FX data for off-ramp quotes and settlement gates.
- Emitting events for frontend and indexer updates.

Important entrypoints:

| Entrypoint | Purpose |
|---|---|
| `deposit` | Pulls tokens into the pool after compliance and amount-binding proofs verify. |
| `transfer` | Performs a pure shielded JoinSplit with fixed 2-input/2-output semantics. |
| `withdraw` | Releases tokens after proof verification and nullifier checks. |
| `register_root_verified` | Advances the Merkle root using a valid Merkle update proof. |
| `disclose` | Verifies a selective-disclosure proof for a known commitment. |
| `offramp_quote` | Reads Reflector on-chain for a live fiat quote. |
| `offramp_quote_twap` | Uses a median of recent oracle records for settlement protection. |
| `leaf_range` | Lets clients rebuild the ordered Merkle tree from durable state. |
| `poseidon_hash` | Exposes on-chain Poseidon for verification and diagnostics. |

### Verifier Contracts

The proof verifiers are separate Soroban contracts generated from circuit
verification keys. The pool calls them through inter-contract communication.

| Verifier | Contract ID | Circuit | Purpose |
|---|---|---|---|
| Disclosure | `CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET` | `circuits/disclosure.circom` | Proves a commitment opens to a disclosed amount and audit context. |
| Transfer | `CACSB6NBWKQNRLN7GODIUQ7JJBLDPSFDTS7J73ZSNWOXQWVWNFGKT5XD` | `circuits/transfer.circom` | Proves ownership, nullifiers, Merkle inclusion, and value conservation. |
| Compliance | `CCPQG73RUCO4TTNZAX2I2BJHFWWPFJI6KVMLLPMBZIAG5XQI3CT43MFP` | `circuits/compliance.circom` | Proves the authenticated depositor is allowed and not denied. |
| Merkle Update | `CD6WAS6UMLJRSVYO3V74VW2JDBTR3ENYIQIKX6FRNHVHMAI2AUQ4E3HY` | `circuits/merkleUpdate.circom` | Proves one leaf insertion transforms an old root into a new root. |

### Deployed Pool

| Item | Value |
|---|---|
| Network | Stellar testnet |
| Pool contract | `CD4CIE7IZSU5J7ZHVPQVEMYKO6CP7RTU3XT7TGUNUCOLKZGINVQZKFFS` |
| Pool deploy tx | `ed44eff8f1a20a00c5df5cafeef3633be39b4844b32be9fbaec52698103aa52f` |
| Token SAC | `CAT6F6HX4B2DBPSS4SIZ257IYSMKDKRJSEGIQTKBDS7LOFRMDXVGFVA2` |
| Reflector oracle | `CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W` |
| Fresh interaction tx | `cedf03f5838152bc8e2acda1161a6e4c290fad2bc1298f90997d384d43ec4048` |

The fresh interaction transaction submitted `pool.poseidon_hash(1,2)` and
returned:

```text
0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a
```

Full deployment details are in
[`deployments/testnet.json`](deployments/testnet.json).

## Security Model

The pool contract enforces several important safety properties:

- The pool builds verifier public inputs itself from typed arguments. Callers do
  not provide arbitrary verifier input vectors.
- Deposits require authenticated sender approval and a commitment amount-binding
  proof.
- Withdrawals bind the released token amount to the proof's negative public
  amount.
- Transfer and withdraw paths require exactly two nullifiers and two output
  commitments.
- Nullifiers can only be spent once.
- Merkle roots can only advance through `register_root_verified`.
- New leaves must already be backed by a recorded commitment.
- A commitment can only be inserted into the tree once.
- FX settlement gates fail closed on missing, stale, thin, or invalid oracle data.
- Admin actions are limited to policy and oracle configuration, and require admin
  authorization.

The detailed threat model is documented in
[`docs/SECURITY.md`](docs/SECURITY.md).

## Event Streaming and Real-Time Updates

The pool emits events for important state transitions:

| Event | When it is emitted |
|---|---|
| `deposit` | A commitment is recorded after a successful deposit. |
| `root` | The Merkle root advances after a verified tree update. |
| `transfer` | A shielded transfer spends nullifiers and records outputs. |
| `withdraw` | Tokens are released to a recipient. |

The frontend uses two layers of synchronization:

1. Recent activity is read from Stellar RPC `getEvents` for live UI updates.
2. Authoritative Merkle state is rebuilt from durable contract storage using
   `leaf_count`, `leaf_range`, and `current_root`.

This means the UI can show live activity while still recovering correctly after a
reload, RPC event retention gap, or reconnect.

## Frontend

### Static Corridor Demo

Location: [`frontend/`](frontend)

The static demo is the main corridor experience. It includes:

- Sender, corridor, receiver, and regulator pages.
- Client-side proof generation with local WASM and zkey artifacts.
- Stellar testnet reads and writes.
- Recent activity feed.
- Durable note storage for demo flows.
- Freighter wallet connection with fallback testnet key.
- Transaction status, loading states, and friendly error handling.
- Responsive layout for desktop and mobile.

Run it locally:

```bash
npm install
npm run serve
```

Open:

```text
http://localhost:8000
```

Direct demo routes:

```text
http://localhost:8000/demo
http://localhost:8000/demo/send
http://localhost:8000/demo/corridor
http://localhost:8000/demo/receive
http://localhost:8000/demo/audit
```

### Next.js Wallet App

Location: [`apps/web/`](apps/web)

The Next app demonstrates Freighter wallet connection, balance reads, payment
construction, transaction signing, transaction submission, error states, and
production build checks.

Run it locally:

```bash
cd apps/web
npm install
npm run dev
```

## Technology Stack

| Layer | Technology |
|---|---|
| Blockchain | Stellar Soroban |
| Smart contracts | Rust, Soroban SDK |
| Token custody | Stellar Asset Contract |
| ZK circuits | Circom |
| Proof system | Groth16 over BN254 |
| Proof tooling | snarkjs, circomlibjs |
| Oracle | Reflector SEP-40 FX oracle |
| Static frontend | HTML, CSS, JavaScript modules |
| Wallet | Freighter |
| App frontend | Next.js, React, TypeScript, Tailwind CSS |
| Tests | Cargo tests, Node scripts, Playwright |
| CI/CD | GitHub Actions |

## Repository Structure

```text
.
├── apps/web/                 # Next.js wallet app
├── circuits/                 # Circom circuits and verification keys
├── contracts/pool/           # Soroban pool contract
├── deployments/              # Testnet deployment records
├── docs/                     # Architecture, security, testing, demo notes
├── frontend/                 # Static corridor demo
├── scripts/                  # Circuit, test, deployment, and demo scripts
├── .github/workflows/ci.yml  # CI pipeline
└── README.md
```

## Installation

Prerequisites:

- Node.js 22 or newer
- npm
- Rust stable
- Stellar CLI for contract deployment or live CLI interaction
- A browser with Freighter if testing wallet signing manually

Install root dependencies:

```bash
npm install
```

Install Next app dependencies:

```bash
npm install --prefix apps/web
```

## Environment Variables

The checked-in demo uses the current testnet contract IDs by default. For a fresh
deployment, use these variables with
[`scripts/deploy-testnet.sh`](scripts/deploy-testnet.sh):

| Variable | Description |
|---|---|
| `SOURCE_ACCOUNT` | Stellar CLI identity used to deploy and sign. |
| `TOKEN_ADDRESS` | Stellar Asset Contract token address. |
| `FX_ORACLE` | Reflector SEP-40 oracle contract address. |
| `INITIAL_ROOT` | 32-byte Merkle genesis root hex. |
| `ASP_ROOT` | 32-byte allow-list root hex. |
| `DENY_LIST_JSON` | JSON array of four 32-byte deny-list values. |
| `NETWORK` | Optional. Defaults to `testnet`. |
| `OUT` | Optional deployment output path. |

Secrets should stay in the Stellar CLI key store or a CI secret manager. Do not
commit private keys, `.env` files, or secret deployment JSON.

## Testing

Run the main local verification command:

```bash
npm run ci
```

This runs:

```text
lint -> typecheck -> frontend unit tests -> contract tests -> frontend build
```

Individual commands:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contracts
npm run test:pages
npm run build
```

Latest verified local output:

```text
npm run test:unit
=== 15/15 unit tests passed ===
```

```text
npm run test:contracts
test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

```text
npm run test:pages
=== 10/10 routing checks passed ===
```

```text
npm run build
Compiled successfully
Generating static pages (5/5)
```

More testing details are in [`docs/TESTING.md`](docs/TESTING.md).

## CI/CD Pipeline

GitHub Actions workflow:

```text
.github/workflows/ci.yml
```

The pipeline runs on every push and pull request:

1. Checkout repository.
2. Set up Node.js.
3. Set up Rust.
4. Install dependencies.
5. Run frontend linting.
6. Run TypeScript checks.
7. Run frontend unit tests.
8. Run Soroban contract tests.
9. Build the frontend.
10. Collect deployment/build artifacts.

The Soroban WASM artifact step is present but non-blocking because hosted CI
runners need Stellar CLI installation before that can be made mandatory.

## Deployment Workflow

The current testnet deployment is already recorded in
[`deployments/testnet.json`](deployments/testnet.json).

For a fresh deployment:

1. Build or regenerate the circuits.
2. Build verifier WASMs.
3. Build the pool WASM.
4. Configure Stellar CLI keys outside git.
5. Export the deployment variables listed above.
6. Run:

```bash
./scripts/deploy-testnet.sh
```

7. Verify constructor readbacks.
8. Submit a harmless interaction such as `poseidon_hash(1,2)`.
9. Update frontend contract IDs and deployment metadata.
10. Run the full test suite.

Rollback strategy:

- Keep each deployment JSON artifact.
- Repoint the frontend to the last known-good pool and verifier IDs.
- Redeploy only after verifier keys, pool constructor arguments, and frontend IDs
  are aligned.

## Demo Walkthrough

1. Start the static frontend with `npm run serve`.
2. Open `/demo/send`.
3. Connect Freighter or use the testnet demo key.
4. Enter an amount and destination corridor.
5. Send into the corridor.
6. Watch the corridor activity and commitment state update.
7. Move to the receiver view and off-ramp the note.
8. Open the regulator view and generate a disclosure proof.
9. Try the tamper controls to see invalid proofs rejected.

The narrated demo outline is in
[`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Screenshots

Add final submission screenshots here:

- Landing page
- Sender page
- Corridor activity page
- Receiver/off-ramp page
- Regulator disclosure page
- Test output
- CI run output
- Contract explorer pages

## Known Limitations

- The public demo key is intentionally shared for testnet convenience. Do not use
  that pattern for production funds.
- Full public deposit and withdraw click-through requires the demo account to hold
  the specific testnet USDC asset used by the deployed pool.
- Instrumented line coverage is not currently configured. The repository provides
  scenario-based test evidence instead.
- The contracts have been internally reviewed and tested, but not professionally
  audited by an external firm.
- Next.js build currently emits non-fatal warnings from the Stellar SDK's
  `sodium-native` dependency packaging.

## Troubleshooting

### Playwright cannot launch Chromium on macOS

If the sandbox blocks Chromium, run the browser test in a normal terminal:

```bash
npm run serve
npm run test:pages
```

### Stellar CLI cannot connect

Check network access and the selected Stellar CLI network:

```bash
stellar network ls
stellar keys ls
```

### Deposit fails with insufficient balance

The pool custodies a specific testnet USDC SAC. The signing account must hold
that asset and have the proper trustline.

### Proof verification fails

Make sure the frontend circuit artifacts, verification keys, deployed verifier
contracts, and pool constructor addresses all come from the same build.

### Merkle root mismatch

Reload the frontend and let it rebuild the tree from durable contract state. The
authoritative source is `leaf_count`, `leaf_range`, and `current_root`, not local
browser state.

## Additional Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/TESTING.md`](docs/TESTING.md)
- [`docs/ONCHAIN.md`](docs/ONCHAIN.md)
- [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md)
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)

## License

See [`LICENSE`](LICENSE).
