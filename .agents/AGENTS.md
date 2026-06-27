# Project Rules and Customizations

## Bot Identity
- The trading/arbitrage bot is named **Helena**. Always refer to the bot as **Helena** when communicating with the user.

## Development Patterns and Rules
- **Configurable Issuers:** Never hardcode issuer addresses (like Bitstamp USD). Always import them from `config.ts` and resolve them dynamically from `.env`.
- **Fault-Tolerant Transactions:** Never propagate uncaught exceptions from network/transact calls. Let the `OrderManager` catch exceptions and return `{ success: false, error: ... }` objects.
- **Oracle Safety:** Implement caching for oracle prices. Halt trading (return `0`) if the oracle price fails and cache has expired.
- **Reserve Checks:** Always verify that the account has enough free XRP balance above the ledger reserve + security buffer before placing offers.
- **Database Mod:** Never modify `db.json` from outside while the bot process is active, as it will be overwritten. Always stop the bot first.
