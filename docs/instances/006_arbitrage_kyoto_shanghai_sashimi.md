# 006 — Arbitrage × Kyoto↔Shanghai :: Sashimi

> **Arbitraje Cross-Venue entre XRPL DEX y Binance con XRP**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 006 |
| **Nombre** | Arbitrage × Kyoto↔Shanghai :: Sashimi |
| **Estrategia** | Arbitrage (2-Leg Cross-Venue) |
| **Conectores** | Kyoto (XRPL DEX) ↔ Shanghai (Binance) |
| **Activos** | Sashimi (XRP en ambos venues) |
| **Estado** | ✅ Código existe, pendiente API keys Binance |
| **Riesgo** | Medio (riesgo de ejecución parcial "una pierna") |
| **Capital mínimo** | 100 XRP (XRPL) + $100 USDT (Binance) |
| **Capital recomendado** | 500 XRP + $500 USDT |

---

## ¿Qué hace?

Detecta diferencias de precio entre el DEX de XRPL y Binance, y ejecuta simultáneamente en ambos venues para capturar el spread.

### Dirección A: BUY DEX → SELL CEX
```
XRPL DEX ask: $2.48    ← Comprar aquí (barato)
Binance bid:  $2.52    ← Vender aquí (caro)
Spread bruto: 1.6%
Fees (~0.2%): -0.2%
Net profit:   ~1.4%    ✅ Ejecutar
```

### Dirección B: BUY CEX → SELL DEX
```
Binance ask:  $2.48    ← Comprar aquí
XRPL DEX bid: $2.52    ← Vender aquí
```

### Modelo de capital bilateral

```
┌─────────────────┐        ┌─────────────────┐
│   XRPL (Kyoto)  │        │ Binance (Shanghai) │
│                 │        │                    │
│  500 XRP        │        │  500 XRP           │
│  $0 USD         │        │  $500 USDT         │
│                 │        │                    │
│  ← Compra XRP   │        │  → Vende XRP       │
│     con USD     │        │     por USDT       │
└────────┬────────┘        └────────┬───────────┘
         │                          │
         └── Rebalanceo periódico ──┘
         (withdraw/deposit cuando
          inventario se desequilibra)
```

> **Importante**: No se necesita transferir XRP entre venues para cada trade. Solo rebalancear cuando una side se agote.

---

## Configuración `.env`

```bash
STRATEGY=arbitrage

# XRPL (Kyoto)
XRPL_NETWORK=mainnet
XRPL_SEED=sEdxxxxxxxxxxxxxxxxxxxxxxxx
USD_ISSUER=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B

# Binance (Shanghai)
BINANCE_API_KEY=tu_key
BINANCE_API_SECRET=tu_secret

# Arbitrage params
ARB_MIN_SPREAD_PCT=0.5            # Spread mínimo para ejecutar (0.5%)
ARB_TRADE_SIZE_XRP=50             # Tamaño por leg
ARB_MAX_SLIPPAGE_PCT=0.2          # Slippage máximo aceptable
ARB_COOLDOWN_MS=30000             # Esperar 30s entre trades
ARB_MAX_PARTIAL_RISK_USD=25.0     # Riesgo máximo si solo una pierna se ejecuta

# Protecciones
MM_MAX_LOSS_USD=50.0
```

---

## Riesgos específicos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|:----------:|:-------:|-----------|
| **Ejecución parcial** | Media | Alto | Limit de riesgo por pierna |
| **Latencia asimétrica** | Alta | Medio | XRPL es 3-5s vs Binance 100ms |
| **Price slippage** | Media | Medio | Max slippage configurable |
| **Rebalanceo** | Baja | Bajo | Alertas cuando inventario < 20% |

---

## Archivos Relevantes

| Archivo | Descripción |
|---------|-------------|
| [arbitrage.ts](file:///c:/Users/lexar/Desktop/xrpL/src/strategies/arbitrage.ts) | Estrategia de arbitraje 2-leg |
| [cexConnector.ts](file:///c:/Users/lexar/Desktop/xrpL/src/cexConnector.ts) | Conector Binance |
| [dexBookReader.ts](file:///c:/Users/lexar/Desktop/xrpL/src/dexBookReader.ts) | Lector de orderbook DEX |
