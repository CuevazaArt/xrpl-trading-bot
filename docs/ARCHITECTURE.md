# Helena — Documentación de Arquitectura

## Patrones y Antipatrones

> Documentación de referencia para el equipo de desarrollo. Generada a partir del análisis
> de la ejecución en vivo del bot Helena (2026-06-27).

---

## ✅ Patrones Establecidos (Seguir Siempre)

### 1. Template Method para Estrategias
- **Dónde**: `AbstractStrategy` → `onInit()` + `tick()` + `cleanup()`
- **Regla**: Toda estrategia nueva DEBE extender `AbstractStrategy` y usar `fetchBalances()` / `updateDashboardWithBalances()` en vez de reimplementar la consulta de balances.

### 2. Fault-Tolerant Transactions
- **Dónde**: `OrderManager.submitTransaction()`
- **Regla**: NUNCA propagar excepciones de red. Siempre retornar `{ success: false, error: ... }`.
- **Regla**: Limpiar `localSequenceMap` en caso de error para auto-corregir con la red.

### 3. HFT Submit (Async)
- **Dónde**: `OrderManager` usa `client.submit()` (no `submitAndWait`)
- **Regla**: Para operaciones de alta frecuencia, usar `submit()` con tracking de secuencia local. Reservar `submitAndWait()` solo para scripts one-shot donde la latencia no importa.

### 4. Cancel Before Replace
- **Dónde**: `marketMaker.ts` tick logic
- **Regla**: SIEMPRE cancelar órdenes activas antes de colocar nuevas para evitar acumulación de OwnerCount. Nunca asumir que una orden fue "filled" solo porque desapareció del orderbook.

### 5. Cooldown entre Operaciones
- **Dónde**: `marketMaker.ts` → `cooldownLedgers`
- **Regla**: Respetar un cooldown mínimo entre ciclos de colocación de órdenes. Configurar via `MM_COOLDOWN_LEDGERS` en `.env`.

### 6. Oracle Degradation Graceful
- **Dónde**: `MultiOracle.getConsensusPrice()` con `confidence < 0.5`
- **Regla**: Si el oráculo tiene pocas fuentes, advertir pero NO detener el trading. Solo detener si `price <= 0` o `consensus === null`.

### 7. Exponential Backoff para Reconexión
- **Dónde**: `connectWithRetry()` en `index.ts`
- **Regla**: Toda reconexión debe usar backoff exponencial con tope máximo. No reintentar en loop tight.

### 8. Graceful Shutdown
- **Dónde**: `SIGINT/SIGTERM` handlers en `index.ts`
- **Regla**: Al apagar, SIEMPRE: (1) cancelar órdenes activas, (2) notificar Telegram, (3) desconectar client.

### 9. Strategy Factory Pattern
- **Dónde**: `strategies/index.ts` → `createStrategy()`
- **Regla**: Agregar nuevas estrategias al switch del factory y exportarlas. Nunca instanciar estrategias directamente fuera del factory.

### 10. Configurable Issuers
- **Dónde**: `config.ts` → `usdIssuer` desde `.env`
- **Regla**: NUNCA hardcodear direcciones de emisores. Siempre resolverlos desde `config.ts`.

---

## ❌ Antipatrones Conocidos (Evitar / Corregir)

### 1. Polling datos estáticos cada tick
- **Problema**: `server_info` se llama cada ~3s pero la reserva base de la red cambia cada meses.
- **Impacto**: ~240 RPCs/minuto innecesarias.
- **Fix**: Cachear `server_info` con TTL de 1 hora.

### 2. Múltiples instancias de singletons
- **Problema**: `MultiOracle` se instancia en `StrategyManager` Y en `index.ts` (para HealthMonitor). Son 2 instancias que hacen 8 HTTP calls/tick en vez de 4.
- **Fix**: Crear UNA instancia en `index.ts` e inyectarla a ambos consumidores.

### 3. WalletManager duplicado
- **Problema**: Se crea uno en `index.ts` (L102) y otro en `StrategyManager` (L46).
- **Fix**: Inyectar la instancia de `index.ts` al `StrategyManager`.

### 4. console.warn/console.error sin logger
- **Problema**: `walletManager.ts` L183 usa `console.warn` directo, rompiendo el formato de log estructurado.
- **Fix**: Usar `log.warn()` del logger del módulo.

### 5. Fire-and-forget para componentes críticos
- **Problema**: ArbitrageScanner se lanza sin monitoreo. Si crashea, nadie lo nota.
- **Fix**: Integrar como observer del StrategyManager con health reporting.

### 6. Fill detection por polling
- **Problema**: `checkForFills()` hace `account_offers` RPC y deduce fills por ausencia. No distingue fill de cancel externo.
- **Fix**: Escuchar eventos `account_tx` del WebSocket que incluyen metadata del resultado.

### 7. No timeout en ticks
- **Problema**: Si un RPC call se cuelga, `tickInProgress` queda `true` permanentemente y el bot se congela.
- **Fix**: Envolver el tick en `Promise.race` con timeout de 15 segundos.

### 8. uncaughtException handler que no termina
- **Problema**: El handler global mantiene el proceso vivo después de una excepción no controlada, potencialmente con estado corrupto.
- **Fix**: En producción, loguear, cancelar órdenes, y `process.exit(1)`. Usar pm2 para restart.

---

## 📊 Métricas de Performance (Baseline)

| Métrica | Valor Actual | Objetivo |
|---------|-------------|----------|
| RPCs por tick | ~12 | ≤ 6 (con caching) |
| HTTP calls por tick (oracle) | 4-8 | 4 (singleton) |
| Latencia tick | ~500ms-1s | ≤ 300ms |
| OwnerCount steady state | ~5 (2 orders + 3 trustlines) | ≤ 7 |
| Fill rate de órdenes | 97.5% | N/A (depende de mercado) |

---

## 📁 Módulos del Sistema

| Módulo | Archivo | Responsabilidad |
|--------|---------|-----------------|
| Entry Point | `index.ts` | Boot sequence, DI, lifecycle |
| Strategy Manager | `strategyManager.ts` | Tick orchestration, guards |
| Order Manager | `orderManager.ts` | TX submission, sequence tracking |
| Wallet Manager | `walletManager.ts` | Balance queries, reserve check |
| Multi Oracle | `multiOracle.ts` | Consensus price from 4 APIs |
| WebSocket Reader | `websocketReader.ts` | Ledger/orderbook/account subscriptions |
| Dashboard | `dashboard.ts` | Web UI server (Express) |
| Health Monitor | `healthMonitor.ts` | Periodic health snapshots |
| Strategy Base | `strategies/AbstractStrategy.ts` | Template method base class |
| Strategy Factory | `strategies/index.ts` | Strategy instantiation |
| DB | `db.ts` | JSON persistence for balances/txs |
| Cleanup | `cleanup.ts` | Batch offer cancellation (HFT) |

---

## 💰 Modelo de Rentabilidad del Market Maker

### Fórmula de Profit por Roundtrip

```
Compra a:  midPrice × (1 − spread/2 + inventoryBias)
Venta a:   midPrice × (1 + spread/2 + inventoryBias)
Profit %:  spread (el spread ES el profit por roundtrip completado)
```

### Rangos de Profit Configurados

| Parámetro | Env Var | Default | Profit/Roundtrip |
|-----------|---------|:-------:|:----------------:|
| Spread mínimo | `MM_MIN_SPREAD` | 0.005 (0.5%) | $0.053 por 10 XRP |
| Spread base | `MM_BASE_SPREAD` | 0.01 (1.0%) | $0.106 por 10 XRP |
| Spread máximo | `MM_MAX_SPREAD` | 0.02 (2.0%) | $0.212 por 10 XRP |
| Inventory bias | (calculado) | ±0.5% max | ±$0.053 adicional |

### Potencial Anualizado (APR estimado)

Con cooldown de 3 ledgers (~9s), el máximo teórico es 9,600 roundtrips/día.

| Escenario | Fill Rate | Roundtrips/día | APR (spread 1%) |
|-----------|:---------:|:--------------:|:----------------:|
| Teórico (100% fills) | 100% | 9,600 | ~9,600% |
| Optimista (mercado líquido) | 10% | 960 | ~960% |
| Realista (mercado normal) | 2-5% | 192-480 | 192-480% |
| Conservador (baja liquidez) | 0.5% | 48 | ~48% |
| Testnet (sin contrapartes) | ~0% | ~0 | 0% |

### Fee-Aware Spread Floor (implementado)

Helena consulta el fee real de la red via `server_info` (cacheado 5 min) y calcula dinámicamente
el spread mínimo rentable:

```
breakevenSpread = (feeXRP × 4 TXs × midPrice) / (orderAmount × midPrice) × profitMargin
```

- `MM_MIN_PROFIT_MARGIN` (default: 1.5) asegura un 50% de margen sobre el breakeven puro.
- Si los fees de red suben drásticamente, Helena ensancha el spread automáticamente.
- Con fees actuales (~10 drops), el floor es ~0.0006% (insignificante vs. spread base de 1%).

### Factores de Riesgo

| Factor | Impacto | Mitigación actual |
|--------|---------|:-:|
| TX fees (4 por roundtrip) | Costo fijo por ciclo | ✅ Fee-aware spread floor |
| Cancel sin fill (costo puro) | Pérdida de fees sin ingreso | ⚠️ Cooldown limita frecuencia |
| Adverse selection | Fills tóxicos pre-movimiento | ⚠️ Solo inventory bias |
| Inventory risk | Exposición a caída de XRP | ⚠️ Bias + max position |
| Spread crossing (auto-fill) | Pérdida del spread completo | ❌ Sin protección |

---

## 🔄 Alternativas para Mejorar Fill Rate

### ✅ Implementado: Carousel Market Maker (4 modos rotativos)

Helena opera en un **carrusel cíclico** que rota entre 4 modos de trading, ejecutando cada uno
durante una ventana de N ledgers antes de pasar al siguiente. Entre rotaciones, TODAS las
órdenes activas se cancelan (clean slate), eliminando riesgos de auto-competencia.

```
🔵 Tight Passive (10L) → 🟢 Standard Passive (10L) → 🔴 Aggressive IOC (5L) → ⚪ Rest (5-20L) → 🔵 ...
```

#### Modo 1: 🔵 Tight Passive
- Spread apretado (0.3%) para maximizar probabilidad de fill
- Env: `MM_TIGHT_SPREAD=0.003`, `MM_CAROUSEL_TIGHT_LEDGERS=10`

#### Modo 2: 🟢 Standard Passive
- Spread dinámico (1% base) con volatilidad + fee floor
- Es la lógica original de Helena

#### Modo 3: 🔴 Aggressive IOC
- Lee el orderbook DEX (`book_offers`), cruza con `tfImmediateOrCancel` si hay edge
- Env: `MM_IOC_MIN_DEX_EDGE=0.002` (mínimo 0.2% ventaja para cruzar)
- **Resultado verificado**: 1 fill en el primer ciclo (+1.53% edge detectado)

#### Modo 4: ⚪ Rest/Observe
- Sin órdenes activas, solo monitorea precios
- Duración adaptativa según fill rate histórico (5-20 ledgers)
- Ahorra fees en mercados muertos

#### Performance tracking por modo
Cada rotación completa imprime un resumen acumulado:
```
🎠 ═══ Resumen Carousel (vuelta completa) ═══
  🔵 Tight Passive:    fills=0, fees=192drops
  🟢 Standard Passive: fills=0, fees=192drops
  🔴 Aggressive IOC:   fills=1, fees=12drops | IOC: 1/5 hits
  ⚪ Rest/Observe:     fills=0, fees=0drops
🎠 ═══════════════════════════════════════════
```

---

## 🎯 Edge Capture Adaptativo (IOC)

### Concepto

El modo IOC no intenta capturar el 100% del edge disponible en el DEX. En vez de eso,
calcula un **target price al X% del edge**, dejando un buffer para maximizar la
probabilidad de fill.

```
targetPrice = oraclePrice + (dexBestPrice - oraclePrice) × edgeCapture
```

### Factor adaptativo

El `edgeCapture` se ajusta automáticamente según el hit rate del IOC:

| Hit Rate IOC | Edge Capture | Tier | Comportamiento |
|:------------:|:------------:|------|----------------|
| > 30% | 95% | GREEDY | Mercado fácil → pedir casi todo |
| 15-30% | 90% | BALANCED | Equilibrado |
| 5-15% | 80% | FLEXIBLE | Mercado difícil → ceder un poco |
| < 5% | 70% | GENEROUS | Mercado muerto → tomar lo que haya |
| < 5 scans | 90% | DEFAULT | Sin datos suficientes aún |

### Resultado verificado (14 min de operación)

- **5 fills IOC** con edge adaptativo (vs. 1 fill en sesión anterior sin adaptativo)
- Ráfaga de **4 fills en 14 segundos** cuando el edge apareció
- Hit rate: **16.7%** (5/30 scans)
- Costo: **12 drops por fill** (vs. 192 drops por modo pasivo sin fills)

---

## 🏗️ Roadmap: Multi-Wallet Architecture

### Decisión arquitectónica (2026-06-27)

**Decisión**: Implementar soporte multi-wallet nativo en Helena en vez de múltiples instancias.

**Razón**: Multi-wallet en un solo proceso permite coordinación anti-competencia,
comparte una sola conexión WebSocket y un solo oracle, y es backwards compatible
(1 wallet configurada = comportamiento idéntico al actual).

### Principio de compatibilidad

```
1 wallet en .env  → Carousel secuencial (comportamiento actual)
N wallets en .env → Cada wallet opera un modo 24/7 en paralelo
```

No se rompe nada existente. El carousel sigue siendo el comportamiento por defecto
para 1 sola wallet.

### Diseño propuesto

```
.env:
  XRPL_WALLET_SEEDS=seedA,seedB,seedC,seedD
  WALLET_A_MODE=tight_passive
  WALLET_B_MODE=standard_passive
  WALLET_C_MODE=ioc_scanner
  WALLET_D_MODE=holding          # No opera, solo guarda

index.ts:
  1. Parsear N seeds desde .env
  2. Crear N instancias de WalletManager
  3. Compartir 1 Client (WebSocket) y 1 MultiOracle
  4. Crear N instancias de MarketMakerStrategy (una por wallet+modo)
  5. StrategyManager orquesta N estrategias en paralelo
  6. Coordinador anti-competencia:
     → Antes de colocar orden, verificar que ninguna otra wallet
       tiene una orden en el mismo rango de precio
```

### Comparación: Multi-instancia vs. Multi-wallet

| Dimensión | Multi-instancia | Multi-wallet (elegido) |
|-----------|:---:|:---:|
| Esfuerzo de implementación | 0 | ~2-3 días |
| Conexiones WebSocket | N | **1** |
| Llamadas al oracle | N× | **1×** |
| RAM | N × 50MB | **~50MB** |
| Coordinación anti-competencia | ❌ Imposible | **✅ Nativa** |
| Tolerancia a fallos | ✅ Aislado | ⚠️ Single process |
| Backwards compatible | N/A | **✅ 1 wallet = carousel** |

### Economía de wallets XRPL

| Concepto | Costo (XRP) | Nota |
|----------|:-----------:|------|
| Base reserve (activar) | 1 XRP | Bloqueado, recuperable |
| Por trustline | +0.2 XRP | Por cada token (USD, EUR...) |
| Por oferta activa | +0.2 XRP | Temporal, se libera al cancelar |
| **4 wallets operativas** | **~5.6 XRP** | Con 1 trustline USD cada una |

> **Recomendación**: Crear las wallets mientras XRP está a precio bajo.
> Si XRP sube 10×, el costo de reserva en USD sube proporcionalmente.

---

## 🚀 Concurrencia y Aislamiento de Recursos (Escalabilidad Horizontal)

Para permitir el escalado a gran escala de Helena, se implementó un sistema de aislamiento dinámico de recursos físicos en disco para mitigar la fricción y colisiones al ejecutar múltiples procesos paralelos (concurrencia horizontal):

### 1. Aislamiento Dinámico de Base de Datos y Logs
- **Base de Datos (`JSONDatabase` / `PaperTradingDB`)**: En lugar de compartir un único archivo físico `db.json` o `paper_trades.json`, cada proceso genera su propio almacenamiento usando el sufijo de su par y estrategia: `db_${strategy}_${usdIssuer}.json` y `paper_trades_${strategy}_${usdIssuer}.json`. Esto reduce los bloqueos de escritura (`EPERM` / `ENOENT`) a cero.
- **Archivos de Registro (`logger` / `LogMonitor`)**: Cada bot redirige su salida de logs de forma independiente a `app_raw_${strategy}_${issuer}.log`.
- **Watchdog Checkpoints**: Los checkpoints de salud se separan de manera similar en `checkpoint_${strategy}_${issuer}.json`.

### 2. Lecciones Aprendidas de Test de Estrés (24 Instancias)
- **Rate-Limiting de WebSocket**: Al levantar 24 bots simultáneos conectándose al mismo nodo de Testnet público de Ripple (`wss://s.altnet.rippletest.net:51233`) en el mismo instante, el servidor de la red aplica restricciones de puertos cerrando sockets temporalmente (`websocket was closed, threshold exceeded`).
- **Mitigación**: Helena utiliza reconexiones asíncronas con backoff exponencial. El bot se auto-recupera reestableciendo la suscripción en el siguiente ticker sin perder consistencia. En producción, se recomienda distribuir la carga a través de múltiples nodos RPC o usar nodos dedicados/privados.
