# 001 — Helena × Kyoto :: Sashimi

> **Market Making + Arbitraje Oportunista en XRPL DEX con XRP/USD**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 001 |
| **Nombre** | Helena × Kyoto :: Sashimi |
| **Estrategia** | Helena (Market Making + IOC Arbitrage) |
| **Conector** | Kyoto (XRPL DEX) |
| **Activos** | Sashimi (XRP/USD vía Bitstamp gateway) |
| **Estado** | ✅ Operativo en Testnet |
| **Riesgo** | Medio |
| **Capital mínimo** | 50 XRP + trustline USD |
| **Capital recomendado** | 200+ XRP |

---

## ¿Qué hace?

Helena opera como **market maker** en el DEX nativo de XRPL, colocando órdenes de compra y venta alrededor del precio de mercado para capturar el spread. Adicionalmente, detecta oportunidades de arbitraje oportunista mediante órdenes IOC (Immediate-or-Cancel) cuando el precio del DEX diverge significativamente del precio de los exchanges centralizados.

### Diagrama de operación

```
                     MultiOracle
                 (Coinbase, Binance,
                  Kraken, CryptoCompare)
                         │
                    Precio Consenso
                         │
                         ▼
    ┌──────────────────────────────────────┐
    │           Helena Engine              │
    │                                      │
    │  ┌──────────┐  ┌──────────┐         │
    │  │ Carousel │──│  Modos:  │         │
    │  │ Rotation │  │ 🔵 Tight │         │
    │  │ (10 led) │  │ 🟢 Std   │         │
    │  │          │  │ 🔴 IOC   │         │
    │  │          │  │ 😴 Rest  │         │
    │  └──────────┘  └──────────┘         │
    │         │                            │
    │    Cada tick (3-5s):                 │
    │    1. ¿Precio movió >threshold?     │
    │    2. Cancelar órdenes viejas       │
    │    3. Colocar nuevas buy+sell       │
    │    4. Verificar fills               │
    └──────────────────────────────────────┘
                         │
                    XRPL DEX (Kyoto)
                    OfferCreate/Cancel
```

---

## Modos de Operación (Carousel)

Helena rota automáticamente entre 4 modos cada N ledgers:

| Modo | Emoji | Spread | Objetivo | Duración |
|------|:-----:|:------:|----------|:--------:|
| **Tight Passive** | 🔵 | 0.15% por lado | Máxima probabilidad de fill, menor profit | 10 ledgers |
| **Standard Passive** | 🟢 | 0.40% por lado | Balance entre fill rate y profit | 10 ledgers |
| **Aggressive IOC** | 🔴 | N/A | Arbitraje oportunista vs CEX | 5 ledgers |
| **Rest** | 😴 | N/A | Pausa para observar mercado | 5 ledgers |

---

## Protecciones de Seguridad

| Protección | Trigger | Acción |
|-----------|---------|--------|
| 🛑 **Stop Loss** | P&L neto < -$5.00 | Pausa, cancela todo |
| 🛑 **Circuit Breaker** | Fees sesión > 5,000 drops | Pausa, cancela todo |
| 🛑 **Balance Guard** | XRP < reserva + 10 XRP | Pausa, cancela todo |
| ⏱️ **Tick Timeout** | Tick > 15s | Aborta tick, continúa siguiente |
| 🔄 **Cancel Before Replace** | Siempre | Cancela antes de recolocar |
| 📊 **Oracle Degraded** | < 2 fuentes sanas | Salta tick |

---

## Guía de Despliegue

### Prerrequisitos

1. **Node.js** v18+ instalado
2. **Git** para clonar el repositorio
3. **Wallet XRPL** con fondos (testnet o mainnet)
4. **Trustline USD** configurada (al emisor Bitstamp en mainnet)

### Paso 1: Clonar el repositorio

```bash
git clone https://github.com/CuevazaArt/xrpl-trading-bot.git
cd xrpl-trading-bot
npm install
```

### Paso 2: Configurar variables de entorno

Copiar `.env.example` a `.env` y configurar:

```bash
# ═══════════════════════════════════════
# CONEXIÓN XRPL
# ═══════════════════════════════════════
XRPL_NETWORK=testnet
# Para mainnet: XRPL_NETWORK=mainnet
# Custom: XRPL_WSS_URL=wss://s1.ripple.com

# ═══════════════════════════════════════
# WALLET
# ═══════════════════════════════════════
XRPL_SEED=sEdxxxxxxxxxxxxxxxxxxxxxxxx
# ⚠️ NUNCA compartir ni commitear este valor

# ═══════════════════════════════════════
# ESTRATEGIA
# ═══════════════════════════════════════
STRATEGY=market_maker

# ═══════════════════════════════════════
# EMISOR USD (Gateway)
# ═══════════════════════════════════════
USD_ISSUER=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B
# ↑ Bitstamp (mainnet). Para testnet usar el emisor apropiado.

# ═══════════════════════════════════════
# PARÁMETROS DE HELENA
# ═══════════════════════════════════════
MM_ORDER_AMOUNT_XRP=10        # Tamaño de cada orden (en XRP)
MM_BASE_SPREAD=0.003          # Spread base (0.3%)
MM_TIGHT_SPREAD=0.0015        # Spread modo tight (0.15%)
MM_DRIFT_THRESHOLD=0.003      # Umbral para recolocar (0.3%)
MM_CAROUSEL_WINDOW=10         # Ledgers por modo
MM_IOC_EDGE_THRESHOLD=0.004   # Edge mínimo para IOC (0.4%)

# ═══════════════════════════════════════
# PROTECCIONES
# ═══════════════════════════════════════
MM_MAX_SESSION_FEE_DROPS=5000  # Circuit breaker: max fees por sesión
MM_MAX_LOSS_USD=5.0            # Stop loss: pérdida máxima en USD
MIN_XRP_RESERVE_BUFFER=10.0    # Buffer sobre la reserva mínima

# ═══════════════════════════════════════
# ORACLE
# ═══════════════════════════════════════
ORACLE_MAX_AGE_SECONDS=60      # Máxima antigüedad del cache
MAX_FEE_DROPS=50000            # Fee máximo por transacción
```

### Paso 3: Verificar configuración

```bash
# Verificar que compila
npm run typecheck

# Ver el saldo de la wallet (sin operar)
npm run balance
```

### Paso 4: Ejecutar

```bash
# Modo desarrollo (con hot-reload)
npm run dev

# Modo producción
npm run build && npm start
```

### Paso 5: Monitorear

- **Dashboard web**: http://localhost:3000
- **Logs en consola**: formato estructurado con timestamps
- **Archivos de log**: Registros de transacciones en `data/db.json`

---

## Tuning y Optimización

### Para mercados volátiles (spread alto)
```bash
MM_BASE_SPREAD=0.005          # Spread más amplio (0.5%)
MM_TIGHT_SPREAD=0.003         # Tight menos agresivo
MM_IOC_EDGE_THRESHOLD=0.006   # IOC solo en edges grandes
MM_CAROUSEL_WINDOW=5          # Rotación más rápida
```

### Para mercados estables (spread bajo)
```bash
MM_BASE_SPREAD=0.002          # Spread ajustado (0.2%)
MM_TIGHT_SPREAD=0.001         # Tight muy agresivo
MM_IOC_EDGE_THRESHOLD=0.003   # IOC en edges pequeños
MM_CAROUSEL_WINDOW=15         # Rotación más lenta
```

### Para cuentas pequeñas (< 100 XRP)
```bash
MM_ORDER_AMOUNT_XRP=5         # Órdenes más pequeñas
MM_MAX_SESSION_FEE_DROPS=2000 # Circuit breaker más conservador
MM_MAX_LOSS_USD=2.0           # Stop loss más estricto
MIN_XRP_RESERVE_BUFFER=15.0   # Buffer más generoso
```

---

## Métricas Clave

| Métrica | Qué medir | Rango esperado |
|---------|-----------|:--------------:|
| **Fill rate** | % de órdenes que se ejecutan | 5-15% en testnet |
| **Spread capturado** | Diferencia buy-sell por roundtrip | 0.1-0.5% |
| **Fees/sesión** | Drops gastados en fees de red | 2,000-5,000 |
| **Net P&L** | Ganancia neta después de fees | Variable |
| **Roundtrips** | Pares buy+sell completados | 1-5/hora |

---

## Troubleshooting

| Problema | Causa probable | Solución |
|----------|---------------|----------|
| `CIRCUIT BREAKER: Fees acumulados` | Demasiadas recolocaciones | Aumentar `MM_MAX_SESSION_FEE_DROPS` o `MM_DRIFT_THRESHOLD` |
| `Stop-loss activated` | P&L negativo sostenido | Revisar spreads, aumentar `MM_MAX_LOSS_USD` |
| `Balance insuficiente` | XRP bajo reserva | Fondear wallet o reducir `MM_ORDER_AMOUNT_XRP` |
| `Oracle degradado` | APIs de precio caídas | Verificar conectividad, esperar restauración |
| `tecUNFUNDED` | No hay USD para la compra | Configurar trustline y fondear USD |
| No hay fills | Mercado sin contraparte | Normal en testnet; en mainnet revisar si el spread es competitivo |

---

## Archivos Relevantes

| Archivo | Descripción |
|---------|-------------|
| [marketMaker.ts](file:///c:/Users/lexar/Desktop/xrpL/src/strategies/marketMaker.ts) | Estrategia completa de Helena |
| [multiOracle.ts](file:///c:/Users/lexar/Desktop/xrpL/src/multiOracle.ts) | Agregador de precios multi-fuente |
| [orderManager.ts](file:///c:/Users/lexar/Desktop/xrpL/src/orderManager.ts) | Gestor de órdenes XRPL |
| [pnlTracker.ts](file:///c:/Users/lexar/Desktop/xrpL/src/pnlTracker.ts) | Tracking de roundtrips y P&L |
| [config.ts](file:///c:/Users/lexar/Desktop/xrpL/src/config.ts) | Todas las variables configurables |
| [.env.example](file:///c:/Users/lexar/Desktop/xrpL/.env.example) | Template de configuración |

---

> **Última actualización**: 2026-06-28
> **Autor**: Plataforma de Trading Automatizado
> **Licencia**: Uso interno
