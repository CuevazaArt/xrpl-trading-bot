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

## Architecture Reference
- See `docs/ARCHITECTURE.md` for full execution flow, patterns, antipatterns, and performance baselines.
