# Auditoría Completa del Proyecto Helena — XRPL Trading Bot

## Radiografía del Proyecto

Helena es un bot de trading para el DEX nativo de XRP Ledger, construido en TypeScript/Node.js. Consta de **14 archivos fuente**, **8 estrategias de trading**, un **dashboard web en tiempo real**, un **escáner de arbitraje atómico** y persistencia local en JSON.

---

## Inventario de Componentes

| Módulo | Archivo | Función | Estado |
| :--- | :--- | :--- | :--- |
| **Entrada principal** | `src/index.ts` | Orquesta conexión, wallet, dashboard, estrategia y reconexión con backoff exponencial | ✅ Sólido |
| **Configuración** | `src/config.ts` | Centraliza todas las variables de entorno con defaults seguros | ✅ Sólido |
| **Wallet** | `src/walletManager.ts` | Genera/restaura wallet, consulta balances, verifica reservas | ✅ Sólido |
| **Órdenes** | `src/orderManager.ts` | Crea/cancela órdenes, envío asíncrono HFT, tracking de secuencia local | ✅ Sólido |
| **Orquestador** | `src/strategyManager.ts` | Tick por ledger, oráculo con caché, validación de reservas | ✅ Sólido |
| **WebSocket** | `src/websocketReader.ts` | Lee streams de ledger, libro de órdenes y transacciones propias | ⚠️ Subutilizado |
| **Dashboard** | `src/dashboard.ts` | Servidor HTTP en puerto 3000 con UI web completa | ✅ Funcional |
| **Base de datos** | `src/db.ts` | Persistencia JSON atómica con cola de escritura | ⚠️ Frágil a escala |
| **Logger** | `src/logger.ts` | Logger con niveles y colores ANSI | ✅ Funcional |
| **Utilidades** | `src/utils.ts` | `saveToEnv()` para persistir en `.env` | ✅ Funcional |
| **Trustlines** | `src/trustlineManager.ts` | Gestión de líneas de confianza USD | ✅ Funcional |
| **Fondeo** | `src/fundUsd.ts` | Script para crear emisor y fondear USD en Testnet | ✅ Funcional |
| **Arbitraje** | `src/arbitrage.ts` | Escáner de arbitraje atómico DEX vs AMM | 🆕 Nuevo |

### Estrategias de Trading (8 en total)

| Estrategia | Filosofía | Condición Ideal |
| :--- | :--- | :--- |
| **Market Maker** | Spread bid/ask dinámico con sesgo de inventario | Mercados laterales con volumen |
| **Dorothy** | DCA Long en caídas dentro de tendencia alcista (Heikin Ashi) | Mercado alcista con pullbacks |
| **Elphaba** | DCA Short en subidas dentro de tendencia bajista | Mercado bajista con rebotes |
| **Louise** | DCA Long con señal de Heikin Ashi diario | Mercados con patrones claros |
| **Anti-Louise** | DCA Short con señal de Heikin Ashi diario | Mercados con patrones claros |
| **Masha** | DCA Multi-Timeframe (SMA semanal + horaria) | Debilidad macro + micro sincronizadas |
| **Thusnelda** | Basket DCA (múltiples tokens) con exit global | Diversificación pasiva |
| **Agartha** | Moonshot con trailing stop y entrada límite | Breakouts y rallies explosivos |

---

## Crítica Honesta

### Lo que está bien hecho ✅
1.  **Arquitectura modular y bien desacoplada:** `IStrategy` permite enchufar cualquier estrategia nueva sin tocar el core.
2.  **Reconexión automática con backoff exponencial** en `index.ts` — resiliente ante cortes de red.
3.  **Dashboard web integrado** — monitoreo visual sin dependencias externas.
4.  **Mitigación de costos configurables** — Oracle halt, max fee, reserve buffer.
5.  **Envío asíncrono HFT** con tracking local de secuencia — velocidad competitiva.

### Lo que necesita mejorar ⚠️

#### 1. El `websocketReader.ts` está completamente desaprovechado
El archivo tiene código para escuchar cambios en el libro de órdenes (`OfferCreate`) y transacciones de la propia cuenta en tiempo real, pero **ninguna estrategia lo consume**. Todas las estrategias solo reaccionan al evento `ledgerClosed` (cada 3-4 segundos). Los eventos del reader se emiten al vacío.

#### 2. La base de datos JSON (`db.ts`) no escala
El archivo `db.json` crece indefinidamente con balances redundantes (registra un snapshot completo en cada tick). Con el límite de 200 transacciones es manejable, pero los balances no tienen límite y el archivo ya supera los 60KB en pocas horas. En producción continua (24/7), esto puede llegar a varios MB por día.

#### 3. El archivo `.env.example` no documenta las variables de seguridad nuevas
Las variables `HALT_ON_ORACLE_FAILURE`, `ORACLE_MAX_AGE_SECONDS`, `MAX_FEE_DROPS` y `MIN_XRP_RESERVE_BUFFER` no aparecen en `.env.example`, así que un usuario nuevo no sabría que existen.

#### 4. El escáner de arbitraje es un proceso separado sin coordinación
`src/arbitrage.ts` se ejecuta con su propio `Client` y `Wallet` independientes. Si Helena y el escáner intentan operar la misma cuenta simultáneamente, pueden colisionar en números de secuencia, provocando fallos `tefPAST_SEQ`.

#### 5. Estrategia `market_maker` tiene parámetros hardcodeados
A diferencia de las demás estrategias que leen todo de `config.ts`, el Market Maker tiene `baseSpread`, `minSpread`, `maxSpread`, `orderAmountXRP`, etc. como constantes privadas dentro de la clase.

#### 6. No existe un mecanismo de "paper trading" / modo simulación
No hay forma de probar una estrategia sin arriesgar fondos reales en Mainnet. El bot asume que si está conectado, opera.

---

## Plan de Normalización como Herramienta de Uso Diario

### Fase 1: Estabilización (Imprescindible antes de Mainnet)
- [ ] Documentar TODAS las variables de seguridad en `.env.example`
- [ ] Añadir límite de registros de balances en `db.ts` (máx. 500 registros)
- [ ] Mover los parámetros hardcodeados de `market_maker` a `config.ts` / `.env`
- [ ] Coordinar el escáner de arbitraje con el bot principal (compartir secuencia o unificar en un solo proceso)

### Fase 2: Usabilidad Diaria (Calidad de vida)
- [ ] Crear un comando CLI unificado: `npm.cmd run helena` que ejecute el bot + arbitraje en un solo proceso
- [ ] Implementar un modo `--dry-run` (paper trading) que simule órdenes sin firmar transacciones reales
- [ ] Añadir endpoint `/api/pnl` al dashboard que calcule automáticamente las ganancias/pérdidas realizadas y no realizadas
- [ ] Agregar notificaciones de eventos críticos (por ejemplo, vía webhook a Telegram o Discord)

### Fase 3: Rendimiento Avanzado (Competitivo)
- [ ] Conectar las estrategias al `websocketReader` para reaccionar a cambios de libro en tiempo real (no solo a `ledgerClosed`)
- [ ] Implementar spread dinámico basado en volatilidad real (ATR calculado desde velas de Binance)
- [ ] Añadir lógica de *inventory skew* al Market Maker para auto-balancear posiciones
