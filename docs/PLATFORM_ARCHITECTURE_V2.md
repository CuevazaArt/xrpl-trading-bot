# Arquitectura de Biblioteca Modular — Trading Platform v2

## 1. Estado Actual y Problema

### Lo que existe hoy

```
src/
  ├─ strategies/          ← 9 estrategias, todas hardcoded a XRPL
  │   ├─ marketMaker.ts   (Helena — MM + IOC arb)
  │   ├─ dorothy.ts       (DCA Long)
  │   ├─ elphaba.ts       (DCA Short)
  │   ├─ louise.ts        (Grid Long)
  │   ├─ anti_louise.ts   (Grid Short)
  │   ├─ masha.ts         (MA Crossover)
  │   ├─ thusnelda.ts     (Multi-asset Binance)
  │   ├─ agartha.ts       (Trailing Stop Entry)
  │   └─ arbitrage.ts     (DEX↔CEX 2-leg)
  │
  ├─ orderManager.ts      ← Solo XRPL
  ├─ walletManager.ts     ← Solo XRPL
  ├─ cexConnector.ts      ← Solo Binance
  └─ multiOracle.ts       ← REST polling
```

### Problema
Toda estrategia está **acoplada a XRPL**. `IStrategy.init()` recibe `Client` y `Wallet` de xrpl.js directamente. Para correr Dorothy en Uniswap o Helena en Binance, habría que reescribir cada estrategia.

---

## 2. Arquitectura Propuesta

### Principio: Strategy × Connector = Instance

```
┌─────────────────────────────────────────────────────────────┐
│                    INSTANCE = Strategy × Connector × Asset  │
│                                                             │
│  ┌───────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ Strategy  │ ×  │  Connector   │ ×  │  Asset Config    │  │
│  │ (Helena)  │    │  (XRPL DEX)  │    │  (XRP/USD)       │  │
│  │ (Dorothy) │    │  (Binance)   │    │  (ETH/USDT)      │  │
│  │ (Agartha) │    │  (Uniswap)   │    │  (SOL/USDC)      │  │
│  └───────────┘    └──────────────┘    └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Matriz de Combinaciones

|  | XRPL DEX | Binance | Kraken | Coinbase | Uniswap | PancakeSwap | Jupiter |
|--|:--------:|:-------:|:------:|:--------:|:-------:|:-----------:|:-------:|
| **Helena** (MM) | ✅ actual | 🔜 | 🔜 | 🔜 | 🔮 | 🔮 | 🔮 |
| **Dorothy** (DCA↑) | ✅ actual | 🔜 | 🔜 | 🔜 | 🔮 | 🔮 | 🔮 |
| **Elphaba** (DCA↓) | ✅ actual | 🔜 | 🔜 | – | – | – | – |
| **Louise** (Grid↑) | ✅ actual | 🔜 | 🔜 | – | 🔮 | 🔮 | – |
| **Anti-Louise** (Grid↓) | ✅ actual | 🔜 | – | – | – | – | – |
| **Masha** (MA) | ✅ actual | 🔜 | 🔜 | – | – | – | – |
| **Agartha** (Trail) | ✅ actual | 🔜 | 🔜 | 🔜 | 🔮 | 🔮 | 🔮 |
| **Thusnelda** (Multi) | – | ✅ actual | 🔜 | – | – | – | – |
| **Arbitrage** (2-leg) | ✅ actual | ✅ actual | 🔜 | 🔜 | 🔮 | 🔮 | 🔮 |

> ✅ Existe | 🔜 Fácil (mismo cluster) | 🔮 Requiere nuevo connector | – No aplica

---

## 3. Diseño de la Biblioteca

### Estructura de Directorios

```
src/
  ├─ core/                          ← Shared library (chain-agnostic)
  │   ├─ interfaces/
  │   │   ├─ IConnector.ts          ← Contrato universal de ejecución
  │   │   ├─ IStrategy.ts           ← Contrato de estrategia (sin dependencia de chain)
  │   │   ├─ IWallet.ts             ← Abstracción de wallet/signing
  │   │   └─ IOracle.ts             ← Contrato de precio
  │   │
  │   ├─ engine/
  │   │   ├─ StrategyRunner.ts      ← Reemplaza StrategyManager (chain-agnostic)
  │   │   ├─ InstanceManager.ts     ← Orquesta múltiples instancias
  │   │   └─ EventBus.ts            ← Comunicación entre instancias
  │   │
  │   ├─ safety/
  │   │   ├─ CircuitBreaker.ts      ← Stop-loss, fee limits (extraído de Helena)
  │   │   ├─ PnLTracker.ts          ← Tracking universal
  │   │   └─ RiskManager.ts         ← Exposición por venue/asset
  │   │
  │   ├─ oracle/
  │   │   ├─ MultiOracle.ts         ← Agregador multi-fuente (actual)
  │   │   ├─ DexPriceOracle.ts      ← Precio desde orderbook DEX
  │   │   └─ WebSocketOracle.ts     ← Feed en tiempo real
  │   │
  │   ├─ persistence/
  │   │   ├─ Database.ts            ← Abstracción DB (JSON / SQLite / Postgres)
  │   │   └─ StateManager.ts        ← Persistencia de estado por instancia
  │   │
  │   └─ utils/
  │       ├─ logger.ts
  │       ├─ config.ts
  │       └─ seedVault.ts
  │
  ├─ connectors/                    ← Un módulo por cluster de exchanges
  │   ├─ xrpl/
  │   │   ├─ XrplConnector.ts       ← Implementa IConnector con xrpl.js
  │   │   ├─ XrplWallet.ts          ← Implementa IWallet
  │   │   └─ XrplWebSocket.ts       ← Streams nativos del ledger
  │   │
  │   ├─ cex/
  │   │   ├─ BinanceConnector.ts    ← REST + WS
  │   │   ├─ KrakenConnector.ts
  │   │   ├─ CoinbaseConnector.ts
  │   │   └─ CexWallet.ts           ← API key auth
  │   │
  │   ├─ evm/
  │   │   ├─ EvmConnector.ts        ← ethers.js base
  │   │   ├─ UniswapRouter.ts       ← Uniswap V3 integration
  │   │   ├─ PancakeRouter.ts       ← PancakeSwap BSC
  │   │   ├─ OneInchAggregator.ts   ← 1inch routing
  │   │   └─ EvmWallet.ts           ← Private key / Ledger HW
  │   │
  │   └─ solana/
  │       ├─ SolanaConnector.ts     ← @solana/web3.js
  │       ├─ JupiterRouter.ts       ← Jupiter aggregator
  │       └─ SolanaWallet.ts
  │
  ├─ strategies/                    ← Estrategias puras (chain-agnostic)
  │   ├─ helena/
  │   │   ├─ MarketMaker.ts         ← Carousel MM (usa IConnector)
  │   │   └─ config.ts
  │   ├─ dorothy/
  │   │   ├─ DcaLong.ts
  │   │   └─ config.ts
  │   ├─ elphaba/
  │   │   ├─ DcaShort.ts
  │   │   └─ config.ts
  │   ├─ louise/
  │   │   ├─ GridLong.ts
  │   │   └─ config.ts
  │   ├─ agartha/
  │   │   ├─ TrailingEntry.ts
  │   │   └─ config.ts
  │   ├─ masha/
  │   │   ├─ MaCrossover.ts
  │   │   └─ config.ts
  │   └─ arbitrage/
  │       ├─ CrossVenue.ts          ← Arb entre 2 connectors
  │       └─ config.ts
  │
  └─ instances/                     ← Configuración por instancia
      ├─ helena-xrpl.yaml
      ├─ dorothy-binance.yaml
      ├─ agartha-uniswap.yaml
      └─ instance.schema.json
```

---

## 4. Interfaces Core

### IConnector — El contrato universal

```typescript
interface IConnector {
  readonly name: string;
  readonly cluster: 'xrpl' | 'cex' | 'evm' | 'solana';

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Orders
  placeLimitOrder(params: LimitOrderParams): Promise<OrderResult>;
  placeMarketOrder(params: MarketOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<CancelResult>;
  getActiveOrders(): Promise<ActiveOrder[]>;

  // Data
  getBalance(asset: string): Promise<AssetBalance>;
  getOrderBook(pair: TradingPair, depth: number): Promise<OrderBook>;
  getTicker(pair: TradingPair): Promise<Ticker>;

  // Events
  on(event: 'fill', cb: (fill: FillEvent) => void): void;
  on(event: 'priceUpdate', cb: (price: PriceUpdate) => void): void;
}
```

### IStrategyV2 — Chain-agnostic

```typescript
interface IStrategyV2 {
  readonly name: string;

  init(ctx: StrategyContext): Promise<void>;
  tick(state: TickState): Promise<void>;
  cleanup(): Promise<void>;
}

interface StrategyContext {
  connector: IConnector;
  oracle: IOracle;
  pnl: PnLTracker;
  safety: CircuitBreaker;
  config: Record<string, any>;
  logger: Logger;
}
```

---

## 5. Multi-Asset Config

### Trading Pair Descriptor

```typescript
interface TradingPair {
  base: { symbol: string; chain: string; address?: string; decimals: number; };
  quote: { symbol: string; chain: string; address?: string; decimals: number; };
}
```

### Ejemplo YAML de instancias

```yaml
# helena-xrpl.yaml
strategy: helena
connector: xrpl-dex
pair:
  base: { symbol: XRP, chain: xrpl, decimals: 6 }
  quote: { symbol: USD, chain: xrpl, address: "rvYAfWj5...", decimals: 15 }
params:
  baseSpread: 0.01
  orderAmount: 10
safety:
  maxLossUsd: 5.0

# dorothy-binance-eth.yaml
strategy: dorothy
connector: binance
pair:
  base: { symbol: ETH, chain: binance, decimals: 8 }
  quote: { symbol: USDT, chain: binance, decimals: 8 }
params:
  profitFactor: 0.05
  maxRungs: 5

# agartha-uniswap-wxrp.yaml
strategy: agartha
connector: uniswap-v3
pair:
  base: { symbol: WXRP, chain: ethereum, address: "0x...", decimals: 18 }
  quote: { symbol: USDC, chain: ethereum, address: "0xA0b8...", decimals: 6 }
params:
  trailingStopPct: 15.0
```

---

## 6. Exchange Clustering

| Cluster | SDK | Latencia | Fees | Wallet |
|---------|-----|:--------:|:----:|--------|
| **XRPL** | xrpl.js | 3-5s/block | 0.00001 XRP | Seed phrase |
| **CEX** | REST/WS | 50-200ms | 0.1% | API keys |
| **EVM** | ethers.js | 12-15s/block | $2-50 gas | Private key |
| **Solana** | @solana/web3.js | 400ms/slot | $0.00025 | Keypair |

---

## 7. Portfolio Compositions

```yaml
# Conservative XRP Accumulator
instances:
  - { strategy: dorothy, connector: xrpl-dex, pair: XRP/USD, allocation: 40% }
  - { strategy: helena, connector: xrpl-dex, pair: XRP/USD, allocation: 30% }
  - { strategy: louise, connector: binance, pair: XRP/USDT, allocation: 30% }

# Multi-Venue Arbitrageur
instances:
  - { strategy: arbitrage, connectors: [xrpl-dex, binance], pair: XRP, allocation: 50% }
  - { strategy: agartha, connector: binance, pair: ETH/USDT, allocation: 25% }
  - { strategy: helena, connector: uniswap-v3, pair: WXRP/USDC, allocation: 25% }

# Diversified Multi-Asset
instances:
  - { strategy: dorothy, connector: binance, pair: BTC/USDT, allocation: 20% }
  - { strategy: dorothy, connector: binance, pair: ETH/USDT, allocation: 20% }
  - { strategy: dorothy, connector: binance, pair: SOL/USDT, allocation: 20% }
  - { strategy: helena, connector: xrpl-dex, pair: XRP/USD, allocation: 20% }
  - { strategy: agartha, connector: binance, pair: XRP/USDT, allocation: 20% }
```

---

## 8. Catálogo de Estrategias

| Estrategia | Enfoque | Mejor Venue | Multi-Asset |
|-----------|---------|:-----------:|:-----------:|
| **Helena** | Market Making + IOC Arb | DEX baja liquidez | ✅ |
| **Dorothy** | DCA Long (acumulación) | CEX alta liquidez | ✅ |
| **Elphaba** | DCA Short (cobertura) | CEX alta liquidez | ✅ |
| **Louise** | Grid Long (rango bull) | CEX o DEX | ✅ |
| **Anti-Louise** | Grid Short (rango bear) | CEX | ✅ |
| **Masha** | MA Crossover (trend) | CEX con WS | ✅ |
| **Agartha** | Trailing Stop Entry | CEX o DEX EVM | ✅ |
| **Thusnelda** | Multi-asset rotational | CEX multi-par | Ya lo es |
| **Arbitrage** | Cross-venue 2-leg | 2 venues distintos | ✅ |

---

## 9. Roadmap de Migración

| Fase | Qué | Estimado |
|:----:|-----|:--------:|
| **0** | Estabilizar Helena XRPL (roundtrips rentables) | 1 semana |
| **1** | Extraer `IConnector` + `IStrategyV2` interfaces | 1 día |
| **2** | Crear `XrplConnector` wrapper | 2 días |
| **3** | Migrar Helena a IStrategyV2 | 2 días |
| **4** | Crear `BinanceConnector` | 2 días |
| **5** | Helena × Binance (primera combo cross-cluster) | 1 día |
| **6** | Migrar Dorothy + Agartha | 2 días |
| **7** | YAML Instance Manager | 2 días |
| **8** | EvmConnector + Uniswap | 5 días |
| **9** | Portfolio compositions + PM2 | 2 días |

> [!IMPORTANT]
> **No romper lo que funciona.** Cada fase es backwards-compatible. Las estrategias actuales siguen funcionando sin cambios hasta que se migran voluntariamente.
