# Project Rules and Customizations

## Bot Identity
- The trading/arbitrage bot is named **Helena**. Always refer to the bot as **Helena** when communicating with the user.

## Development Patterns and Rules
- **Configurable Issuers:** Never hardcode issuer addresses (like Bitstamp USD). Always import them from `config.ts` and resolve them dynamically from `.env`.
- **Fault-Tolerant Transactions:** Never propagate uncaught exceptions from network/transact calls. Let the `OrderManager` catch exceptions and return `{ success: false, error: ... }` objects.
- **Oracle Safety:** Implement caching for oracle prices. Halt trading (return `0`) if the oracle price fails and cache has expired.
- **Reserve Checks:** Always verify that the account has enough free XRP balance above the ledger reserve + security buffer before placing offers.
- **Database Mod:** Never modify `db.json` from outside while the bot process is active, as it will be overwritten. Always stop the bot first.
- **Cancel Before Replace:** Always cancel active orders before placing new ones to prevent OwnerCount accumulation. Never assume an order was "filled" just because it disappeared from `account_offers`.
- **Singleton Dependencies:** Never create duplicate instances of `MultiOracle` or `WalletManager`. Instantiate once in `index.ts` and inject into all consumers.
- **HFT Submit:** Use `client.submit()` (async) for trading operations. Reserve `submitAndWait()` for one-shot scripts (cleanup, setup). Always track sequences locally via `localSequenceMap`.
- **Structured Logging Only:** Never use `console.log/warn/error` directly. Always use `createLogger('ModuleName')` for consistent timestamp + level formatting.
- **Cooldown Enforcement:** All strategies must respect a minimum cooldown between order placement cycles to avoid flooding the network.
- **Tick Safety:** Strategy ticks should be wrapped with a timeout guard to prevent indefinite hangs from unresponsive RPC calls.
- **CEX Spot Trading Fees (Asset Deduction):** On centralized exchanges (like Binance), buying an asset often incurs a trading fee (e.g. 0.1%) deducted directly from the purchased asset itself. This results in a slightly smaller wallet balance than the filled order quantity. When placing sell orders (e.g., Trailing Exit or Stop Loss), always query the actual free balance of the token first and execute the minimum of the expected position size and the actual balance (`Math.min(positionQty, freeAsset)`) to avoid `insufficient balance` errors.
- **Agartha Pure Trailing Thesis (No Stop Loss, No Break-Even, No Min Profit):** The Agartha strategy is designed exclusively to capture large, asymmetric pumps in high-volatility Alpha tokens. Under no circumstances should a Stop Loss, Break-Even logic, or Minimum Profit barrier (`minProfitPct`) be implemented, as they sabotage the bot's ability to ride a pump and result in logical conflicts with trailing stops. Small losses are expected and compensated by large trailing exit captures.
- **Database Purge State Preservation:** Never run a database purge offline without documenting/restoring the states of open positions (quantities, entry and peak prices) in the exchange. If a purge is required, stop the bot, back up the active states, purge, write the backup states back to the database, and then start the bot. This prevents orphan positions on CEX platforms.

## Architecture Reference
- See `docs/ARCHITECTURE.md` for full execution flow, patterns, antipatterns, and performance baselines.
- See `docs/AGARTHA_PATTERNS_ANTIPATTERNS.md` for CEX Alpha execution patterns, fee adjustments, and crash recovery.

## Interaction Flow & Strategy Assembly
- **Operator Workflow**: When the user requests a bot/strategy assembly (arbitrage first), the agent must formulate the design, ask ONLY for necessary API keys/credentials and minimum funding requirements, configure/compile the codebase, run the bot in a task, and actively manage/monitor execution statistics (logs, P&L, risk) in real time.

