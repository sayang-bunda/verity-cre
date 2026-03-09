# Verity CRE Workflows

> **Chainlink CRE (Compute Runtime Environment) workflows for autonomous prediction market lifecycle management**

Three off-chain workflows built on `@chainlink/cre-sdk` that power the Verity prediction market protocol. Each workflow reads on-chain data (including **Chainlink Price Feeds**), runs AI analysis via Groq, and writes reports back to the smart contract through the **Chainlink Keystone Forwarder**.

---

## Workflow Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    CHAINLINK CRE WORKFLOWS                   │
│                                                              │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │   CRE-1        │  │   CRE-2         │  │   CRE-3      │  │
│  │   Safe Market  │  │   Manipulation  │  │   Smart      │  │
│  │   Creation     │  │   Detection     │  │   Resolution │  │
│  │                │  │                 │  │              │  │
│  │  Groq AI       │  │  Groq AI +      │  │  Chainlink   │  │
│  │  Risk Scoring  │  │  Chainlink PF   │  │  PF + AI     │  │
│  └───────┬────────┘  └────────┬────────┘  └──────┬───────┘  │
│          │                    │                   │          │
│          └────────────┬───────┴───────────────────┘          │
│                       ▼                                      │
│              Keystone Forwarder                              │
│              → Verity Smart Contract                         │
└──────────────────────────────────────────────────────────────┘
```

### CRE-1: Safe Market Creation

```
User proposes market → Groq AI analyzes question → Risk score (0-100)
  ├─ Low risk (0-30):   Auto-create via Keystone Forwarder
  ├─ Medium (31-70):    BFT consensus among 21 CRE nodes → create if agreed
  └─ High (71-100):     Reject + record rejection on-chain
```

For **CryptoPrice** markets, CRE-1 automatically:
- Parses the target price from the question (e.g., "Will ETH reach $5,000?")
- Maps the asset to the correct **Chainlink Price Feed** address
- Stores both values on-chain for deterministic CRE-3 resolution

### CRE-2: Manipulation Detection

```
On-chain betting activity → Read market data + Chainlink Price Feed
  → Groq AI analyzes patterns (volume spikes, wash trading, price impact)
  → Manipulation score (0-100)
    ├─ Score ≥ 70: Pause market
    └─ Score < 30: Allow trading
```

For **CryptoPrice** markets, reads **real-time price from Chainlink** via `latestRoundData()` to detect if betting patterns correlate with actual price movements.

### CRE-3: Smart Resolution

```
SettlementRequested event → Read market category
  ├─ CryptoPrice (deterministic):
  │     Read Chainlink Price Feed → latestRoundData()
  │     price ≥ targetValue? → YES (confidence=100) / NO (confidence=100)
  │
  └─ Event/Social/Other (AI-driven):
        NewsAPI + Groq AI → outcome + confidence
        confidence ≥ 90? → resolve market
        confidence < 90? → escalate (refund users)
```

---

## Chainlink Price Feeds Used (Base Sepolia)

| Pair | Address | Decimals |
|---|---|---|
| **ETH/USD** | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 8 |
| **BTC/USD** | `0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298` | 8 |

---

## Files that use Chainlink

### Shared / Config

| File | Chainlink Usage |
|---|---|
| [`contracts/abi/ChainlinkPriceFeed.ts`](contracts/abi/ChainlinkPriceFeed.ts) | **Chainlink AggregatorV3Interface ABI** — `decimals()`, `description()`, `latestRoundData()`, `getRoundData()`. Used by CRE-2 and CRE-3 to read on-chain price data. |
| [`contracts/abi/index.ts`](contracts/abi/index.ts) | Barrel export for `ChainlinkPriceFeed` ABI and `VerityCore` ABI. |
| [`project.yaml`](project.yaml) | CRE project settings. Defines RPC URLs for Base Sepolia, experimental chain selector (`123456`), and Keystone Forwarder address (`0x9c8094090357e19449036dCD9F747001e8DC2394`). |

### CRE-1 — Safe Market Creation

| File | Chainlink Usage |
|---|---|
| [`cre-1/main.ts`](cre-1/main.ts) | Workflow entry point. Uses `@chainlink/cre-sdk` Runtime to orchestrate AI-driven market creation and submit reports via Keystone Forwarder. |
| [`cre-1/src/market.ts`](cre-1/src/market.ts) | `getPriceFeedAddress()` — maps crypto asset symbols (ETH, BTC) to Chainlink Price Feed addresses. `parseTargetValueFromQuestion()` — extracts USD target from question text. Encodes ABI payload and calls `evmClient.writeReport()` via CRE SDK. |
| [`cre-1/src/config.ts`](cre-1/src/config.ts) | Defines `priceFeeds` config mapping (`ETH→address`, `BTC→address`) and `chainSelectorName` for Chainlink CRE routing. |
| [`cre-1/config.staging.json`](cre-1/config.staging.json) | Staging config with Chainlink Price Feed addresses (`ethUsdPriceFeed`, `btcUsdPriceFeed`), contract address, and chain selector. |
| [`cre-1/workflow.yaml`](cre-1/workflow.yaml) | CRE workflow definition for `safemarket-creation-staging`. Defines the Chainlink CRE workflow trigger and config reference. |

### CRE-2 — Manipulation Detection

| File | Chainlink Usage |
|---|---|
| [`cre-2/main.ts`](cre-2/main.ts) | Workflow entry point. Reads on-chain market data and Chainlink Price Feed data, runs AI manipulation analysis, and submits reports via Keystone Forwarder. |
| [`cre-2/src/evm.ts`](cre-2/src/evm.ts) | **Core Chainlink Price Feed reader.** `readChainlinkPrice()` calls `latestRoundData()` on price feed contracts via `@chainlink/cre-sdk` EVMClient. Returns real-time ETH/USD and BTC/USD prices (8 decimals → human-readable). Also submits manipulation reports via `writeReport()`. |
| [`cre-2/src/groq.ts`](cre-2/src/groq.ts) | Builds AI analysis prompts that include Chainlink Price Feed data (current price, price impact percentage) for manipulation pattern scoring. |
| [`cre-2/src/config.ts`](cre-2/src/config.ts) | Config type definition with `ethUsdPriceFeed` and `btcUsdPriceFeed` Chainlink addresses. |
| [`cre-2/config.staging.json`](cre-2/config.staging.json) | Staging config with Chainlink Price Feed contract addresses for Base Sepolia. |

### CRE-3 — Smart Resolution

| File | Chainlink Usage |
|---|---|
| [`cre-3/main.ts`](cre-3/main.ts) | Workflow entry point. Triggered by `SettlementRequested` log event. Branches resolution by market category — uses Chainlink Price Feed for crypto, Groq AI for others. |
| [`cre-3/src/evm.ts`](cre-3/src/evm.ts) | **Deterministic crypto resolution via Chainlink Price Feed.** `resolveCryptoPrice()` calls `latestRoundData()` on the market's stored `priceFeedAddress`, compares `latestPrice ≥ targetValue`, and returns YES/NO outcome with 100% confidence. Also reads market info and resolution metadata via EVMClient. |
| [`cre-3/src/config.ts`](cre-3/src/config.ts) | Config type with Chainlink-related fields for CRE-3 resolution workflow. |
| [`cre-3/workflow.yaml`](cre-3/workflow.yaml) | CRE workflow definition for `cre-3-smartresolve-staging`. Uses Log Trigger on `SettlementRequested` event. |

---

## Project Structure

```
verity-cre/
├── project.yaml                  # CRE project settings (RPC, chain selector, forwarder)
├── contracts/
│   └── abi/
│       ├── ChainlinkPriceFeed.ts # AggregatorV3Interface ABI
│       ├── VerityCore.ts         # Verity contract ABI
│       └── index.ts              # Barrel exports
├── cre-1/                        # Safe Market Creation
│   ├── main.ts                   # Workflow entry point
│   ├── workflow.yaml             # CRE workflow definition
│   ├── config.staging.json       # Staging config (price feeds, contract)
│   └── src/
│       ├── market.ts             # Price feed mapping + ABI encoding
│       ├── config.ts             # Config type definition
│       └── types.ts              # AIAnalysis type
├── cre-2/                        # Manipulation Detection
│   ├── main.ts                   # Workflow entry point
│   ├── config.staging.json       # Staging config
│   └── src/
│       ├── evm.ts                # Chainlink PF reads + report submission
│       ├── groq.ts               # AI manipulation analysis
│       ├── config.ts             # Config type
│       └── types.ts              # MarketData type
└── cre-3/                        # Smart Resolution
    ├── main.ts                   # Workflow entry point
    ├── workflow.yaml             # CRE workflow definition (Log Trigger)
    ├── config.staging.json       # Staging config
    └── src/
        ├── evm.ts                # Chainlink PF resolution + market reads
        ├── config.ts             # Config type
        └── types.ts              # Resolution types
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- [Chainlink CRE CLI](https://docs.chain.link/cre)

### Run Workflow (Simulator)

```bash
# CRE-1: Market Creation
cre-cli simulate --workflow cre-1/workflow.yaml --settings staging-settings

# CRE-2: Manipulation Detection
cre-cli simulate --workflow cre-2/workflow.yaml --settings staging-settings

# CRE-3: Smart Resolution
cre-cli simulate --workflow cre-3/workflow.yaml --settings staging-settings
```

### Environment Variables

Configure secrets via CRE CLI:
- `GROQ_API_KEY` — Groq LLM API key
- `NEWS_API_KEY` — NewsAPI key (for CRE-3 event resolution)

---

## Tech Stack

| Component | Technology |
|---|---|
| **Runtime** | Chainlink CRE SDK (`@chainlink/cre-sdk`) |
| **Price Data** | Chainlink AggregatorV3Interface |
| **Report Delivery** | Chainlink Keystone Forwarder |
| **AI** | Groq LLM (Llama 3.3 70B) |
| **ABI Encoding** | viem |
| **Network** | Base Sepolia (Chain ID: 84532) |

---

## License

MIT
