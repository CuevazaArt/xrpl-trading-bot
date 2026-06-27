# 🤖 Helena — Manual de Usuario

> **Helena** es un bot de market making automatizado para el DEX del XRP Ledger.
> Opera con un sistema de carrusel cíclico de 4 modos que maximiza oportunidades
> de profit mientras minimiza riesgo y fees.

---

## 📋 Tabla de Contenidos

1. [Requisitos Previos](#-requisitos-previos)
2. [Instalación Rápida](#-instalación-rápida)
3. [Configuración](#-configuración)
4. [Modos de Operación](#-modos-de-operación-carousel)
5. [Comandos Disponibles](#-comandos-disponibles)
6. [Dashboard Web](#-dashboard-web)
7. [Monitoreo y Logs](#-monitoreo-y-logs)
8. [Tips para Uso Rentable](#-tips-para-uso-más-rentable)
9. [Errores Comunes a Evitar](#-errores-comunes-a-evitar)
10. [Solución de Problemas](#-solución-de-problemas)
11. [Glosario](#-glosario)

---

## 🔧 Requisitos Previos

| Requisito | Versión Mínima |
|-----------|:-:|
| **Node.js** | v18+ |
| **npm** | v9+ |
| **Cuenta XRPL** | Con seed (wallet) |
| **Trustline USD** | Configurada hacia el emisor |
| **XRP** | Mínimo 15 XRP (reserva + buffer) |

> ⚠️ **NUNCA uses tu wallet principal de mainnet para pruebas.**
> Usa siempre testnet primero: https://xrpl.org/xrp-testnet-faucet.html

---

## 🚀 Instalación Rápida

```bash
# 1. Clonar el repositorio
git clone https://github.com/CuevazaArt/xrpl-trading-bot.git
cd xrpl-trading-bot

# 2. Instalar dependencias
npm install

# 3. Crear archivo de configuración
cp .env.example .env

# 4. Editar .env con tu wallet seed y configuración
# (ver sección de Configuración abajo)

# 5. Iniciar en modo desarrollo (con hot-reload)
npm run dev
```

### Verificación rápida

Si ves estos mensajes, Helena está funcionando:

```
[Main] Conexión establecida.
[WalletManager] Billetera cargada exitosamente: rXXXXXXXX
[StrategyManager] Cargando estrategia: 'market_maker'
[XRPLMarketMakerStrategy] 🎠 Carousel MM iniciado. Modo: 🔵 Tight Passive
```

---

## ⚙️ Configuración

### Variables Esenciales (.env)

```env
# === OBLIGATORIAS ===
XRPL_WS_URL=wss://s.altnet.rippletest.net:51233   # Testnet
XRPL_WALLET_SEED=sEdxxxxxxxxxxxxxxxxxxxxxxxx        # Tu seed
STRATEGY=market_maker                                # Estrategia activa
USD_ISSUER=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B        # Emisor USD (Bitstamp)

# === RECOMENDADAS ===
LOG_LEVEL=INFO                    # DEBUG para diagnóstico, INFO para producción
MAX_FEE_DROPS=50000               # Máximo fee aceptable por TX
MIN_XRP_RESERVE_BUFFER=10.0       # XRP libre mínimo sobre la reserva
```

### Variables del Market Maker (Carousel)

```env
# === Spread y Orden ===
MM_BASE_SPREAD=0.01               # 1% spread base (Standard mode)
MM_MIN_SPREAD=0.005               # 0.5% spread mínimo
MM_MAX_SPREAD=0.02                # 2% spread máximo (alta volatilidad)
MM_TIGHT_SPREAD=0.003             # 0.3% spread para modo Tight
MM_ORDER_AMOUNT_XRP=10            # Tamaño de cada orden (XRP)
MM_PRICE_DEVIATION_THRESHOLD=0.003 # 0.3% desviación para recolocar

# === Cooldown y Posición ===
MM_COOLDOWN_LEDGERS=3             # Ledgers entre recolocaciones
MM_MAX_POSITION_XRP=80            # Posición máxima en XRP
MM_TARGET_POSITION_XRP=50         # Posición objetivo (para inventory bias)

# === Fee-Aware Floor ===
MM_MIN_PROFIT_MARGIN=1.5          # Margen sobre breakeven (1.5x = 50% extra)

# === Carousel — Ventanas por Modo (ledgers) ===
MM_CAROUSEL_TIGHT_LEDGERS=10     # 🔵 Tight Passive: ~30s
MM_CAROUSEL_STANDARD_LEDGERS=10  # 🟢 Standard Passive: ~30s
MM_CAROUSEL_IOC_LEDGERS=5        # 🔴 Aggressive IOC: ~15s
MM_CAROUSEL_REST_LEDGERS=5       # ⚪ Rest mínimo: ~15s
MM_CAROUSEL_REST_MAX_LEDGERS=20  # ⚪ Rest máximo (mercado muerto): ~60s

# === IOC Mode ===
MM_IOC_MIN_DEX_EDGE=0.002        # 0.2% edge mínimo para IOC
```

### Variables de Seguridad

```env
HALT_ON_ORACLE_FAILURE=true       # Parar si el oráculo falla
ORACLE_MAX_AGE_SECONDS=60         # Máximo 60s de precio cacheado
MAX_FEE_DROPS=50000               # Nunca pagar más de 0.05 XRP de fee
```

---

## 🎠 Modos de Operación (Carousel)

Helena rota automáticamente entre 4 modos de trading:

```
🔵 Tight → 🟢 Standard → 🔴 IOC → ⚪ Rest → 🔵 Tight → ...
```

### 🔵 Tight Passive (10 ledgers ≈ 30s)

- **Qué hace**: Coloca limit orders con spread apretado (0.3%)
- **Objetivo**: Máxima probabilidad de fill, profit pequeño por trade
- **Cuándo brilla**: Mercados con actividad moderada
- **Riesgo**: Adverse selection (mitigado por ventana corta)

### 🟢 Standard Passive (10 ledgers ≈ 30s)

- **Qué hace**: Limit orders con spread dinámico (1% base, ajustable por volatilidad)
- **Objetivo**: Profit grande por trade, baja frecuencia
- **Cuándo brilla**: Mercados volátiles donde el spread amplio se justifica
- **Riesgo**: Baja probabilidad de fill en mercados tranquilos

### 🔴 Aggressive IOC (5 ledgers ≈ 15s)

- **Qué hace**: Lee el orderbook DEX real y ejecuta IOC (Immediate-or-Cancel) si hay edge
- **Objetivo**: Capturar arbitraje cuando DEX y oracle divergen
- **Cuándo brilla**: Cuando el precio DEX difiere >0.2% del oracle
- **Riesgo**: Slippage (mitigado por threshold configurable)

### ⚪ Rest/Observe (5-20 ledgers ≈ 15-60s)

- **Qué hace**: No coloca órdenes. Solo monitorea precios.
- **Objetivo**: Ahorrar fees cuando el mercado no tiene oportunidades
- **Duración adaptativa**: Se extiende automáticamente si no hay fills recientes

### Transiciones entre modos

> ⚠️ **Importante**: Entre cada modo, Helena cancela TODAS las órdenes activas.
> Cada modo arranca con slate limpio — no hay riesgo de órdenes huérfanas.

---

## 💻 Comandos Disponibles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Iniciar Helena en modo desarrollo (hot-reload) |
| `npm run build` | Compilar TypeScript a JavaScript |
| `npm start` | Iniciar desde código compilado (producción) |
| `npm run typecheck` | Verificar tipos sin compilar |
| `npm run cleanup` | Cancelar TODAS las órdenes abiertas de la cuenta |
| `npm run fund:usd` | Crear trustline y fondear USD en testnet |
| `npm run arbitrage` | Ejecutar escáner de arbitraje standalone |
| `npm test` | Ejecutar tests |

### Flags de línea de comandos

```bash
# Paper trading (simulación sin dinero real)
npm run dev -- --paper --sim-balance 1000

# Activar dashboard CLI en terminal
npm run dev -- --cli-ui

# Activar notificaciones Telegram
npm run dev -- --telegram
```

---

## 📊 Dashboard Web

Helena incluye un dashboard web accesible en:

```
http://localhost:3000
```

Si configuraste `DASHBOARD_TOKEN` en `.env`, agrega el token a la URL:
```
http://localhost:3000?token=tu_token_secreto
```

El dashboard muestra:
- Precio actual (bid/ask/mid)
- Órdenes activas
- Balance XRP y USD
- Modo actual del carousel
- Estado del bot

---

## 📝 Monitoreo y Logs

### Entendiendo los logs

```
2026-06-27T22:30:19.324Z [INFO ] [XRPLMarketMakerStrategy] 🔵 [TIGHT] Precios: ...
                         ^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^
                         Nivel   Módulo                      Modo activo
```

### Iconos de modo en logs

| Icono | Significado |
|:-----:|-------------|
| 🔵 | Tight Passive operando |
| 🟢 | Standard Passive operando |
| 🔴 | Aggressive IOC escaneando DEX |
| ⚪ | Rest/Observe (sin órdenes) |
| 🎠 | Rotación de modo (transición) |

### Mensajes clave a monitorear

| Mensaje | Significado |
|---------|-------------|
| `¡Edge detectado!` | IOC encontró oportunidad de arbitraje |
| `fue ejecutada (FILLED)` | ¡Una orden se llenó! Profit potencial |
| `Fee floor activado` | Fees de red altos, spread elevado automáticamente |
| `ALERTA: Saldo XRP < Reserva` | ⚠️ Fondos insuficientes, Helena no puede operar |
| `Tick timeout` | ⚠️ Un tick tardó >15s, posible RPC lento |
| `Resumen Carousel` | Estadísticas de vuelta completa |

### Resumen de vuelta (cada ~90s)

```
🎠 ═══ Resumen Carousel (vuelta completa) ═══
  🔵 Tight Passive:    fills=0, fees=192drops
  🟢 Standard Passive: fills=0, fees=192drops
  🔴 Aggressive IOC:   fills=1, fees=12drops | IOC: 1/5 hits
  ⚪ Rest/Observe:     fills=0, fees=0drops
🎠 ═══════════════════════════════════════════
```

---

## 💰 Tips para Uso Más Rentable

### 1. Empieza en Testnet
Siempre prueba tu configuración en testnet antes de mainnet.
El testnet XRP es gratis: https://xrpl.org/xrp-testnet-faucet.html

### 2. Ajusta el spread según el mercado

| Condición del mercado | Recomendación |
|----------------------|---------------|
| Alta liquidez (mainnet pares populares) | `MM_BASE_SPREAD=0.005` (0.5%) |
| Liquidez media | `MM_BASE_SPREAD=0.01` (1%) — default |
| Baja liquidez | `MM_BASE_SPREAD=0.02` (2%) |
| Mercado muy volátil | `MM_MAX_SPREAD=0.03` (3%) |

### 3. Optimiza el tamaño de orden

- **Órdenes pequeñas** (5-10 XRP): Menor riesgo por fill adverso, más fills
- **Órdenes grandes** (50-100 XRP): Mayor profit por fill, pero más riesgo
- **Recomendación para inicio**: `MM_ORDER_AMOUNT_XRP=10`

### 4. Usa el modo IOC a tu favor

El modo IOC es el más eficiente en fees (solo gasta cuando hay oportunidad real).
Si el mercado tiene poca actividad:

```env
MM_CAROUSEL_IOC_LEDGERS=10     # Más tiempo escaneando IOC
MM_CAROUSEL_TIGHT_LEDGERS=5    # Menos tiempo en tight (ahorra fees)
```

### 5. Mantén un buffer de reserva holgado

```env
MIN_XRP_RESERVE_BUFFER=15.0    # 15 XRP extra sobre la reserva
```

Esto evita que Helena se detenga por falta de fondos cuando OwnerCount sube.

### 6. Monitorea el resumen del carousel

El resumen de vuelta te dice qué modo está siendo más efectivo. Si IOC tiene
muchos hits, reduce el edge threshold:

```env
MM_IOC_MIN_DEX_EDGE=0.001      # 0.1% edge (más agresivo)
```

### 7. En mainnet, desactiva oráculos innecesarios

Si un oráculo falla frecuentemente, desactívalo para evitar datos malos:

```env
DISABLE_CRYPTOCOMPARE=true
```

### 8. Ajusta el cooldown según la red

En momentos de congestión de la red (fees altos):

```env
MM_COOLDOWN_LEDGERS=5           # Más lento, menos fees
MM_CAROUSEL_REST_LEDGERS=10     # Más descanso
```

---

## ❌ Errores Comunes a Evitar

### 1. ❌ Editar `data/db.json` mientras Helena corre

**Problema**: Helena sobreescribe `db.json` periódicamente. Si lo editas mientras corre,
tus cambios se pierden Y puedes corromper el archivo.

**Solución**: Detén Helena primero (`Ctrl+C`), edita, y reinicia.

### 2. ❌ Ejecutar múltiples instancias del bot

**Problema**: Dos instancias compiten por las mismas sequences, causando `tefPAST_SEQ`
y órdenes duplicadas.

**Solución**: SIEMPRE verifica que no hay otro proceso corriendo antes de iniciar:
```bash
# Windows
tasklist | findstr "node"
# Linux/Mac
ps aux | grep "tsx\|node.*index"
```

### 3. ❌ No limpiar órdenes antes de cambiar configuración

**Problema**: Si cambias el spread o la estrategia sin limpiar, quedan órdenes
huérfanas de la configuración anterior acumulando OwnerCount.

**Solución**:
```bash
# Siempre ejecutar antes de cambiar config
npm run cleanup
```

### 4. ❌ Usar seed de mainnet en testnet (o viceversa)

**Problema**: La misma seed genera la misma wallet en ambas redes, pero el contexto
(balances, trustlines) es completamente diferente.

**Solución**: Usa seeds diferentes para testnet y mainnet. Guárdalas separadas.

### 5. ❌ Ignorar las alertas de reserva

**Problema**: Si Helena reporta `Saldo XRP < Reserva requerida`, significa que no
puede crear nuevas órdenes. El bot sigue corriendo pero no opera.

**Solución**:
- Ejecuta `npm run cleanup` para liberar OwnerCount
- Agrega más XRP a la cuenta
- Aumenta `MIN_XRP_RESERVE_BUFFER`

### 6. ❌ Configurar `MM_ORDER_AMOUNT_XRP` mayor que tu balance

**Problema**: Las órdenes fallan silenciosamente o se llenan parcialmente.

**Solución**: El tamaño de orden debe ser ≤10% de tu XRP disponible.

### 7. ❌ Dejar `LOG_LEVEL=DEBUG` en producción

**Problema**: Los logs DEBUG son extremadamente verbosos (>1000 líneas/minuto).
Llena el disco rápido y reduce rendimiento.

**Solución**: Usa `LOG_LEVEL=INFO` para operación normal. Solo usa DEBUG para
diagnóstico de problemas específicos.

### 8. ❌ No verificar la trustline del emisor USD

**Problema**: Si tu cuenta no tiene trustline hacia el `USD_ISSUER`, las órdenes
que involucran USD fallarán.

**Solución**: Helena verifica automáticamente al inicio. Si falla, crea la trustline
manualmente o ejecuta `npm run fund:usd` en testnet.

### 9. ❌ Cambiar `USD_ISSUER` sin entender las implicaciones

**Problema**: Cada emisor de USD es una moneda diferente en XRPL.
USD de Bitstamp ≠ USD de GateHub ≠ USD de tu emisor de testnet.

**Solución**: Usa siempre el mismo emisor. En mainnet, Bitstamp
(`rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`) es el más líquido.

### 10. ❌ Esperar profit inmediato en testnet

**Problema**: Testnet tiene muy pocos traders reales. Las órdenes pasivas raramente
encuentran contraparte. Esto NO refleja el rendimiento en mainnet.

**Solución**: Testnet es para verificar que el bot funciona correctamente
(sin errores, órdenes válidas, reserva suficiente). El profit real se mide en mainnet.

---

## 🔧 Solución de Problemas

### Helena no arranca

```bash
# Verificar que .env existe
ls .env

# Verificar que la seed está configurada
grep XRPL_WALLET_SEED .env

# Verificar conexión a la red
npm run typecheck
```

### OwnerCount muy alto (>10)

```bash
# Limpiar todas las órdenes abiertas
npm run cleanup
```

### Errores `tefPAST_SEQ`

Esto significa conflicto de sequences. Soluciones:
1. Verificar que no hay otra instancia corriendo
2. Reiniciar Helena (se auto-corrige al reconectar)

### Helena se detiene sin error

Posibles causas:
- Pérdida de conexión WebSocket (se reconecta automáticamente)
- `Ctrl+C` accidental
- Sistema se fue a dormir (laptop)

### Fees inusualmente altos

Si ves `Fee floor activado` en los logs, la red está congestionada.
Helena ensancha el spread automáticamente. Si prefieres pausar:

```env
MAX_FEE_DROPS=5000    # Limitar a 0.005 XRP máximo
```

---

## 📖 Glosario

| Término | Definición |
|---------|-----------|
| **Spread** | Diferencia entre precio de compra y venta. Mayor spread = más profit pero menos fills |
| **Fill** | Cuando alguien acepta tu orden (se ejecuta) |
| **IOC** | Immediate-or-Cancel: orden que se ejecuta al instante o se cancela |
| **Roundtrip** | Ciclo completo: comprar + vender (o viceversa). El profit viene del spread |
| **OwnerCount** | Número de objetos de tu cuenta en el ledger (órdenes, trustlines). Cada uno bloquea 0.2 XRP |
| **Drops** | Unidad mínima de XRP. 1 XRP = 1,000,000 drops |
| **Adverse Selection** | Riesgo de que los fills que recibes sean "tóxicos" (justo antes de un movimiento adverso) |
| **Fee Floor** | Spread mínimo calculado automáticamente para cubrir fees de red |
| **Carousel** | Sistema de rotación cíclica entre 4 modos de trading |
| **Edge** | Ventaja de precio entre el DEX y el oracle (oportunidad de arbitraje) |
| **Inventory Bias** | Sesgo en precios para balancear la posición (si tienes mucho XRP, favorece vender) |
| **Oracle** | Precio de referencia externo (CoinGecko, Binance, Kraken, Coinbase) |
| **Trustline** | Permiso para recibir un token (USD) de un emisor específico en XRPL |

---

> 📅 Última actualización: 2026-06-27
> 📁 Documentación técnica: ver `docs/ARCHITECTURE.md`
