# Slipway — Ammora Launch Terminal

Slipway is a working launch terminal for the Ammora protocol on the GIWA
Sepolia testnet (chain 91342). It is built entirely on the official
[@ammora-protocol/sdk](https://www.npmjs.com/package/@ammora-protocol/sdk)
(0.3.9) and talks to live chain state only: no mock data, no backend.

**Live app:** https://leira-ai.github.io/slipway/

## What it does

- **Launch discovery.** Scans the Ammora atomic launch factory
  (`0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`) for `LaunchCreated` events in
  10k-block chunks (the GIWA RPC log limit), newest first, and indexes every
  launch in a board. Results are cached in the browser so repeat visits resume
  where the last scan stopped.
- **Curve inspection.** For any launch it reads curve state (reserves, spot
  price from the Q64 sqrt price, fee, migration progress) and draws the bonding
  curve by sampling real `ALCClient.quoteExactInput` quotes at 22 sizes and
  deriving marginal prices.
- **Live quotes.** A buy/sell quote panel driven by `ALCClient`, showing
  amount out, curve fee, and effective price at the current block.
- **Launch planner.** The factory's three inputs (name, symbol, metadata URI)
  plus a config picked from the on-chain registry. Slipway predicts the token
  and curve addresses with `ALCClient.getPredictedLaunch`, shows the exact
  `createLaunch` calldata, and simulates the launch against live state. With a
  wallet connected on GIWA Sepolia, the same plan can be executed for real on
  testnet, signed by the visitor's own wallet.
- **Config registry browser.** Lists the launch configs registered on-chain
  with their segment price spans.

## Stack

TypeScript + Vite + viem, with `@ammora-protocol/sdk` for the deployment
registry (`giwaSepoliaAtomicLaunchDeployment`), the factory / curve / registry
ABIs, launch quotes, and launch prediction.

## Run it locally

```bash
npm install
npm run dev
```

## Notes for reviewers

- Testnet only. The app never touches mainnet or any real funds; wallet
  execution is optional, visitor-signed, and restricted to GIWA Sepolia.
- One upstream quirk worth knowing: the SDK's full config decoder
  (`ALCClient.listConfigs` / `getConfig`) throws a viem safe-integer error
  against this registry deployment, because a config field exceeds the JS
  number range in the SDK's ABI typing. Slipway reads the same registry
  through the SDK's exported registry ABI (`enabled`, `getCurve`,
  `configHash`), which decodes correctly, and uses `ALCClient` where it
  works: quotes and launch prediction.
