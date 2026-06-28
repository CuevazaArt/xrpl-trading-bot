# 002 — Helena × Shanghai :: Nigiri

> **Market Making en Binance con XRP/USDT**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 002 |
| **Nombre** | Helena × Shanghai :: Nigiri |
| **Estrategia** | Helena (Market Making) |
| **Conector** | Shanghai (Binance CEX) |
| **Activos** | Nigiri (XRP/USDT) |
| **Estado** | 🔜 Conector existe, pendiente migración a IConnector |
| **Riesgo** | Alto (competencia extrema de bots HFT) |
| **Capital mínimo** | $100 USDT + 50 XRP en Binance |
| **Capital recomendado** | $500+ USDT + 200+ XRP |

---

## ¿Qué hace?

Helena aplica la misma lógica de carousel (Tight → Standard → IOC → Rest) pero ejecutando contra el order book de Binance en vez del DEX XRPL. La ventaja es mayor liquidez y ejecución más rápida (~100ms vs 3-5s). La desventaja es competencia extrema de bots HFT profesionales.

### Diferencias vs Kyoto (XRPL DEX)

| Aspecto | Kyoto (XRPL DEX) | Shanghai (Binance) |
|---------|:-----------------:|:------------------:|
| Latencia | 3-5s/bloque | 50-200ms |
| Fees | 0.00001 XRP (~$0.00001) | 0.1% del trade (~$0.10) |
| Liquidez | $2-10M | $200M+ |
| Competencia | Baja | Extrema |
| Spread típico | 0.1-0.5% | 0.01-0.03% |
| API | OfferCreate (on-chain) | REST + WebSocket |

### Recomendaciones

- **Spread mínimo**: 0.05% (fees de Binance son 0.1% roundtrip)
- **Modo IOC**: Desactivar — no hay edge de arbitraje contra sí mismo
- **Carousel**: Solo Tight + Standard, sin IOC ni Rest
- **Volumen**: Mínimo $50 por trade para que el fee no coma el profit

---

## Configuración `.env`

```bash
STRATEGY=market_maker
CONNECTOR=binance

# Binance API (obtener en binance.com/api-management)
BINANCE_API_KEY=tu_api_key_aqui
BINANCE_API_SECRET=tu_api_secret_aqui

# Par de trading
TRADING_PAIR_BASE=XRP
TRADING_PAIR_QUOTE=USDT

# Helena params ajustados para CEX
MM_ORDER_AMOUNT_XRP=50
MM_BASE_SPREAD=0.0008        # 0.08% (mínimo viable con 0.1% fee)
MM_TIGHT_SPREAD=0.0005       # 0.05%
MM_CAROUSEL_WINDOW=20        # Más tiempo por modo (bloques son ~100ms)

# Protecciones
MM_MAX_SESSION_FEE_DROPS=0   # N/A para CEX
MM_MAX_LOSS_USD=20.0         # Stop loss más holgado por volumen
```

---

## Prerequisitos

1. Cuenta Binance verificada (KYC)
2. API key con permisos: **Enable Spot Trading** (NO enable withdrawals)
3. IP whitelist configurada en Binance
4. Fondos depositados: XRP + USDT

---

## Dependencia

- Requiere: `BinanceConnector` implementando `IConnector` (Fase 4 del roadmap)
- Base: [cexConnector.ts](file:///c:/Users/lexar/Desktop/xrpL/src/cexConnector.ts) ya tiene 80% del código
