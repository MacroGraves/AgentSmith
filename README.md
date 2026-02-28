# AgentSmith

AgentSmith is an Autonomous crypto trading bot. GPT decides when to buy and sell, based on predefined conditions, Binance executes the orders, MySQL keeps the audit trail and allows GPT to reference it.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Architecture](#architecture)
- [Safety Systems](#safety-systems)
- [Logging](#logging)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [TODO](#todo)
- [License](#license)

---

## Features

- **GPT-driven trading** — 4-step decision cycle (Think → Validate → Act → Reflect) per iteration
- **Intelligent pair rotation** — scores 12 USDT pairs by volatility, volume, and trend; selects the best opportunity each cycle
- **Position sizing** — configurable % of balance per trade with hard caps enforced at execution
- **Cranks safety system** — cascading profit ratchets that permanently lock gains as USDC
- **Loss prevention** — `StrictlyNoLosses` mode blocks any sell below entry price
- **Market analysis** — 24h trend detection, volatility scoring, and recommendation signals
- **Full audit trail** — every decision, reasoning chain, and order persisted to MySQL
- **PM2 ready** — runs as a daemon with auto-restart

## Requirements

- Node.js 14+
- MySQL 5.7+ or MariaDB 10.3+
- Binance API key (spot trading enabled)
- OpenAI API key

## Installation

```bash
git clone https://github.com/user/AgentSmith.git
cd AgentSmith
npm install
```

### API Keys

Create the following files (plain text, no formatting):

| File | Contents |
|------|----------|
| `.Keys/OpenAI.key` | OpenAI API key |
| `.Keys/Binance/API.key` | Binance API key |
| `.Keys/Binance/API.secret` | Binance API secret |

### Database

Tables are created automatically on first run. Just ensure the MySQL credentials in `Settings.json` are correct and the target database exists:

```bash
mysql -u root -p -e "CREATE DATABASE agentsmith;"
```

## Configuration

All configuration lives in `Settings.json`.

### Trading Rules

| Setting | Default | Description |
|---------|---------|-------------|
| `MinUSDTForBuy` | 5 | Minimum USDT required to place a buy |
| `MinAssetValueForSell` | 5 | Minimum asset value to place a sell |
| `BuyPercentOfBalance` | 0.10 | Max % of balance per buy order |
| `MaxSingleTradePercent` | 0.10 | Hard cap % per single trade |
| `SellPercentOfHolding` | 0.95 | % of holding to sell per order |
| `MinProfitPercentToSell` | 2 | Minimum profit % before selling |
| `StrictlyNoLosses` | true | Block all sells below entry price |

### Cranks (Annihilation Prevention)

| Setting | Default | Description |
|---------|---------|-------------|
| `Enabled` | true | Enable the cascading ratchet system |
| `ConversionThreshold` | 100 | % gain in a ratchet before cascading right |

When a coin's profit fills all 4 ratchets, the base amount is permanently locked as USDC and the last ratchet resets. `MockBalance` (sum of all R0 values) caps how much the bot can trade with — protecting locked capital.

### Test Mode

Set `Trading.TestMode.Enabled: true` to simulate decisions without placing real orders.

## Usage

### Direct

```bash
node index.js
```

### With PM2

```bash
pm2 start ecosystem.config.js
pm2 logs 0
```

### CLI Flags

| Flag | Example | Description |
|------|---------|-------------|
| `--log` | `--log=numbers` | Filter log output (`numbers`, `gpt`, `trading`, `loop`, `pairs`, `all`) |
| `--fast` | `--fast` | Reduce wait time between iterations |
| `--count` | `--count=10` | Run a fixed number of iterations then exit |

## Architecture

```
┌─────────────┐
│  index.js   │  Main loop: pair → context → GPT → execute
└──────┬──────┘
       │
  ┌────▼─────┐    ┌──────────────┐    ┌─────────────┐
  │   GPT    │───▶│  AutoTrader │───▶│   Binance   │
  │ (4-step) │    │  (executor)  │    │   (orders)  │
  └──────────┘    └──────┬───────┘    └─────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     ┌────▼───┐    ┌────▼────┐   ┌────▼────┐
     │TradeDB │    │ Cranks  │   │DecisionDB│
     │(trades)│    │(safety) │   │(reasoning│
     └────────┘    └─────────┘   └──────────┘
```

### Decision Cycle

Each iteration GPT runs 4 steps:

1. **Think** — analyse market state, balances, and open positions
2. **Validate** — check constraints (balance, min trade, profit target)
3. **Act** — output one action: `buy`, `sell`, `wait`, `query`, or `complete`
4. **Reflect** — evaluate decision quality for the next iteration

### Supported Actions

| Action | Type | Description |
|--------|------|-------------|
| `buy` | Market order | Buy asset at current price |
| `sell` | Market order | Sell asset at current price |
| `buyatprice` | Limit order | Buy at specified price |
| `sellatprice` | Limit order | Sell at specified price |
| `query` | Info | Fetch price or balance |
| `wait` | Delay | Wait N seconds |
| `complete` | Terminal | End loop successfully |
| `stop` / `error` | Terminal | End loop on failure |

## Safety Systems

### Position Sizing

Every buy is capped at `min(BuyPercentOfBalance, MaxSingleTradePercent)` of available USDT — enforced both in the GPT context (so it never asks for more) and at execution time (hard cap regardless of what GPT requests).

### Cranks Ratchets

Profits cascade through 4 ratchets per coin:

```
R0 (trading) → R1 (buffer) → R2 (buffer) → R3 (lock trigger)
```

- R0 = the MockBalance the bot trades with
- When any ratchet reaches 2× the base amount, the overflow moves right
- When R3 fills, the base amount is permanently converted to USDC
- Losses pull from R1/R2 to protect R0

### Loss Prevention

- `StrictlyNoLosses: true` — sell orders are blocked if current price ≤ entry price
- Entry price is tracked per position via TradeDB
- All sells require minimum 2% profit (configurable)

### Circuit Breakers

- 5 consecutive errors pauses trading
- 50 active loop cap prevents runaway processes
- External balance changes detected and flagged
- Exponential backoff on API failures (3 retries)

## Logging

Controlled by `Trading.Values_Only_Logging` in Settings or `--log` CLI flag.

| Filter | Shows |
|--------|-------|
| `numbers` | Pair metrics, loop status, trade executions |
| `gpt` | GPT prompts and responses |
| `trading` | AutoTrader actions |
| `pairs` | Pair selection and rotation |
| `loop` | Loop iteration info |
| `all` | Everything |

Errors and warnings always print regardless of filter. Logs also write to `output.log`.

## Project Structure

```
AgentSmith/
├── Core/
│   ├── AutoTrader.js       # Maps GPT decisions to exchange orders
│   ├── Cranks.js            # Cascading profit ratchet system
│   ├── DecisionDB.js        # Decision persistence
│   ├── ExchangeDiscovery.js # Available exchange detection
│   ├── GPT.js               # 4-step AI decision engine
│   ├── KeyManager.js        # Credential loading
│   ├── Logger.js            # File + console logging
│   ├── MarketAnalysis.js    # Trend and volatility analysis
│   ├── MigrationRunner.js   # DB schema migrations
│   ├── PairDB.js            # Pair scoring persistence
│   ├── PairSelector.js      # Intelligent pair rotation
│   ├── TradeDB.js           # Trade history persistence
│   └── Utils.js             # DB connection, helpers
├── Exchanges/
│   ├── CEX/
│   │   └── Binance.js       # Binance REST adapter
│   └── DEX/                 # (placeholder)
├── Wallet/
│   ├── Core.js              # Blockchain RPC
│   ├── Transactions.js      # Deposit processing
│   └── Users.js             # Account management
├── .Keys/                   # API credentials (gitignored)
├── index.js                 # Entry point and main loop
├── Settings.json            # Configuration
├── ecosystem.config.js      # PM2 config
└── package.json
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot buys nothing / always waits | Check `pm2 logs` for errors. Verify USDT balance ≥ `MinUSDTForBuy`. |
| PM2 crash loop on startup | DB connection likely failing. Check MySQL is running and credentials are correct. Errors now always print even with log filters. |
| `OpenAI.key not found` | Create `.Keys/OpenAI.key` with your API key (plain text). |
| `BUY: NOT POSSIBLE (no trading budget)` | Cranks MockBalance is $0 because no trades exist yet. This is auto-handled — if it persists, check Cranks initialization in logs. |
| Order rejected by Binance | Check `minNotional` in Settings. Binance requires minimum ~$5 per order for most pairs. |
| Sells blocked despite profit | `StrictlyNoLosses` checks entry price from TradeDB. Verify the buy was recorded. Check `MinProfitPercentToSell`. |

## TODO

- [ ] **Uniswap** — DEX integration (Ethereum)
- [ ] **PancakeSwap** — DEX integration (BSC)
- [ ] **Raydium** — DEX integration (Solana)
- [x] **Binance** — CEX integration
- [ ] **KuCoin** — CEX integration
- [ ] **Kraken** — CEX integration
- [ ] Multi-exchange arbitrage support
- [ ] Cold & Hot wallet management
- [ ] Apply Additional LLM's for second opinions

## License

MIT

## Author

MacroGraves
