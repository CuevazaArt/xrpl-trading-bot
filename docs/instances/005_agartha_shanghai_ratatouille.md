# 005 — Agartha × Shanghai :: Dim Sum (Alpha Market)

> **Trailing Stop de Compra y Venta en Binance con Tokens Alpha (USDT)**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 005 |
| **Nombre** | Agartha × Shanghai :: Dim Sum |
| **Estrategia** | Agartha (Trailing Stop Buy + Trailing Stop Sell) |
| **Conector** | Shanghai (Binance Spot Client) |
| **Activos** | Dim Sum (Canasta de Tokens Alpha: FARM, POND, BOB, TA, etc.) |
| **Estado** | ✅ Operativo (Instancia Aislada) |
| **Riesgo** | Alto (activos altamente volátiles y de baja capitalización) |
| **Nocional por activo** | $10 USDT fijo |
| **Capital Mínimo** | `(N * 10 USDT) * 1.05` |

---

## ¿Qué hace?

Esta instancia corre de forma **aislada** y audita la oferta y precio de todos los símbolos pertenecientes al sector **Alpha** en Binance Spot. Funciona en 2 fases automatizadas por símbolo:

### Fase 1: Entrada (Trailing Stop Buy)
Monitorea continuamente la cotización masiva. Si un token toca un mínimo y rebota un porcentaje configurado (ej: 2%), ejecuta una compra a mercado de **10 USDT** para capturar el mechazo inicial.

### Fase 2: Salida (Trailing Stop Sell)
Una vez dentro de la posición:
1. Rastrea el precio máximo alcanzado (`peakPrice`).
2. Activa el trailing una vez superado el umbral mínimo de ganancia.
3. Si el precio retrocede un porcentaje establecido (ej: 3%) desde su máximo local, liquida la posición a mercado protegiendo la rentabilidad.

---

## Configuración `.env`

Ajusta tu archivo `.env` con los siguientes parámetros persistentes (los símbolos se obtienen dinámicamente llamando a `npm run fetch:alpha`):

```bash
# Parámetros operativos
AGARTHA_BINANCE_NOTIONAL=10.0           # Nocional fijo de 10 USDT por posición
AGARTHA_TRAILING_ENTRY_PCT=2.0          # Rebote de 2% desde mínimos para comprar
AGARTHA_TRAILING_EXIT_PCT=3.0           # Caída de 3% desde máximos para vender
AGARTHA_ACTIVATION_PROFIT_PCT=1.5       # Ganancia para activar trailing de salida
AGARTHA_MIN_PROFIT_PCT=1.0              # Beneficio mínimo para permitir salida por trailing
AGARTHA_MAX_HOLDING_MINUTES=60          # Time Stop de 1 hora para liquidar posiciones estancadas
AGARTHA_MAX_CONCURRENT_POSITIONS=30     # Límite de control de capital (máximo 30 posiciones)
```

---

## Despliegue y Ejecución Persistente

Para ejecutar esta instancia aislada de forma persistente en segundo plano (incluso reanudable en otros servidores mediante la copia de `data/helena.db`):

```bash
# Compilar y arrancar localmente
npm run agartha:binance

# Ejecutar de forma persistente con PM2
pm2 start dist/binanceAgarthaRunner.js --name "helena-agartha-binance"
```

Para más detalles sobre la persistencia y migración de estados, consulta la guía:
👉 [docs/AGARTHA_BINANCE_PERSISTENCE.md](../AGARTHA_BINANCE_PERSISTENCE.md)
