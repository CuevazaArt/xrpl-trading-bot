# 005 — Agartha × Shanghai :: Ratatouille

> **Trailing Stop Entry en Binance con ETH/USDT**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 005 |
| **Nombre** | Agartha × Shanghai :: Ratatouille |
| **Estrategia** | Agartha (Trailing Stop Entry + Exit) |
| **Conector** | Shanghai (Binance) |
| **Activos** | Ratatouille (ETH/USDT) |
| **Estado** | 🔜 Requiere BinanceConnector + migración IStrategyV2 |
| **Riesgo** | Medio-Alto (trend-following, pierde en laterales) |
| **Capital mínimo** | $300 USDT |
| **Capital recomendado** | $1,000+ USDT |

---

## ¿Qué hace?

Agartha es una estrategia de **momentum/trend-following** con trailing stop. Funciona en 2 fases:

### Fase 1: Entrada (Trailing Stop Buy)
```
Precio baja → Agartha espera
Precio toca mínimo y rebota +X% → COMPRA (confirma reversal)
```

### Fase 2: Salida (Trailing Stop Sell)
```
Precio sube → Trailing stop sigue el precio a distancia
Precio cae X% desde máximo → VENDE (protege ganancias)
```

### ¿Por qué Ratatouille (ETH)?

- **Tendencias claras**: ETH tiende a moverse en swings de 10-20%
- **Complejidad multicapa**: Como el ratatouille, ETH tiene múltiples capas (DeFi, NFTs, L2s) que generan narrativas y momentum
- **Volatilidad ideal**: Más volátil que BTC, menos que altcoins — sweet spot para trailing

---

## Configuración `.env`

```bash
STRATEGY=agartha
CONNECTOR=binance

BINANCE_API_KEY=tu_key
BINANCE_API_SECRET=tu_secret

TRADING_PAIR_BASE=ETH
TRADING_PAIR_QUOTE=USDT

# Trailing params
AGARTHA_TRAILING_ENTRY_PCT=5.0    # Comprar cuando rebota 5% desde mínimo
AGARTHA_TRAILING_EXIT_PCT=3.0     # Vender cuando cae 3% desde máximo
AGARTHA_MIN_PROFIT_PCT=2.0        # No vender si profit < 2%
AGARTHA_ORDER_AMOUNT=0.1          # 0.1 ETH por trade

MM_MAX_LOSS_USD=50.0
```

---

## Cuándo usar Agartha

| Escenario | ¿Usar? |
|-----------|:------:|
| Mercado con tendencia clara (bull o bear) | ✅ Ideal |
| Mercado lateral/ranging | ❌ Genera whipsaws |
| Volatilidad extrema (>10% diario) | ⚠️ Reducir trailing % |
| Volatilidad baja (<2% diario) | ❌ No genera entries |

---

## Dependencia

- Requiere: `BinanceConnector` (Fase 4) + Agartha migrada a `IStrategyV2` (Fase 6)

## Archivos Relevantes

| Archivo | Descripción |
|---------|-------------|
| [agartha.ts](file:///c:/Users/lexar/Desktop/xrpL/src/strategies/agartha.ts) | Estrategia completa |
