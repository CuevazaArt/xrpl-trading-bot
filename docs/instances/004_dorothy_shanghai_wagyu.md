# 004 — Dorothy × Shanghai :: Wagyu

> **DCA Long de Bitcoin en Binance**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 004 |
| **Nombre** | Dorothy × Shanghai :: Wagyu |
| **Estrategia** | Dorothy (DCA Long) |
| **Conector** | Shanghai (Binance) |
| **Activos** | Wagyu (BTC/USDT) |
| **Estado** | 🔜 Requiere BinanceConnector + migración IStrategyV2 |
| **Riesgo** | Bajo (DCA es inherentemente conservador) |
| **Capital mínimo** | $200 USDT |
| **Capital recomendado** | $1,000+ USDT |

---

## ¿Qué hace?

La misma lógica de Dorothy (comprar en dips, vender en rebotes) pero aplicada a **Bitcoin** en **Binance**. Bitcoin tiene mayor estabilidad y liquidez que XRP, lo que hace que los rungs se llenen con más frecuencia y los take-profits sean más predecibles.

### ¿Por qué Wagyu (BTC)?

- **Liquidez**: $2B+ diario en Binance — fills garantizados
- **Volatilidad controlada**: BTC se mueve 2-5% diario (ideal para DCA)
- **Correlación**: Movimientos de BTC arrastran altcoins — operar BTC es operar el mercado
- **Premium**: Como el Wagyu, BTC es el activo premium del ecosistema

---

## Configuración `.env`

```bash
STRATEGY=dorothy
CONNECTOR=binance

BINANCE_API_KEY=tu_key
BINANCE_API_SECRET=tu_secret

TRADING_PAIR_BASE=BTC
TRADING_PAIR_QUOTE=USDT

DOROTHY_PROFIT_FACTOR=0.03       # TP más conservador (3%) — BTC se mueve menos
DOROTHY_MARGIN_DROP_FACTOR=0.02  # Rungs cada 2%
MAX_RUNGS=5
DOROTHY_ORDER_AMOUNT=0.001       # 0.001 BTC por rung (~$60)

MM_MAX_LOSS_USD=100.0
```

---

## Dependencia

- Requiere: `BinanceConnector` (Fase 4) + Dorothy migrada a `IStrategyV2` (Fase 6)
