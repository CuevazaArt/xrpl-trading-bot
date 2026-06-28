# 🗺️ Diseño Técnico: Arbitraje Multi-Instancia y Multi-Wallet en Helena

Este documento detalla el diseño arquitectónico y las especificaciones técnicas para operar a **Helena** en configuraciones avanzadas de **Multi-Wallet** (dentro del mismo proceso) y **Multi-Instancia** (procesos paralelos aislados), optimizando el arbitraje concurrentemente sin auto-competencia.

---

## 1. Multi-Wallet vs. Multi-Instancia: ¿Cuándo usar cada una?

| Dimensión | Configuración Multi-Wallet (Un Solo Proceso) | Configuración Multi-Instancia (Procesos Aislados) |
| :--- | :--- | :--- |
| **Definición** | Una sola instancia de Helena gestionando $N$ cuentas/claves en paralelo. | Múltiples contenedores Docker o procesos PM2 corriendo de forma aislada. |
| **Ventaja Principal** | **Evita auto-competencia nativa**. Comparte el pool de WebSocket y las consultas de oráculo (máxima eficiencia de recursos y API limits). | **Aislamiento total de fallos**. Si un nodo de red se congela o una instancia crashea, las demás siguen operando. |
| **Desventaja** | Si el proceso principal sufre un crash, se detiene el trading de todas las wallets a la vez. | Mayor consumo de RAM y duplicidad de consultas HTTP a los oráculos/WebSockets. |
| **Rol en Arbitraje** | **Ideal para el arbitraje del mismo par** usando billeteras separadas para el lado comprador y el lado vendedor para evitar bloqueos de secuencia. | **Ideal para operar múltiples pares de tokens distintos** (ej. Instancia 1 para XRP/USD, Instancia 2 para SOL/USD). |

---

## 2. Arquitectura de Control y Anti-Competencia

Cuando operamos múltiples wallets o instancias sobre los mismos libros de órdenes, es crítico evitar que el bot **se arbitre a sí mismo** o que dos de sus billeteras intenten tomar la misma oferta del ledger al mismo tiempo.

```
[Libro de Órdenes DEX] ──> [Fila de Spread Rentable]
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
       [Wallet A: Intenta comprar]    [Wallet B: Intenta comprar]
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
                     ⚠️ ¡Bloqueo de Doble Gasto!
                     (Se desperdician fees de red)
```

### Solución: Coordinador de Exclusividad Local (Centralized Execution Coordinator)
En configuraciones Multi-Wallet, el `StrategyManager` actúa como árbitro central e implementa una tabla de exclusión mutua:

```typescript
interface ActiveArbitrageLock {
  venuePair: string; // ej. "xrpl_dex <-> binance"
  priceBoundary: number;
  direction: 'BUY' | 'SELL';
  lockedUntil: number; // Timestamp de expiración (bloqueo por ledger o timeout)
}
```

*   **Regla de Exclusión**: Antes de que cualquier adaptador DEX/CEX dispare una orden, debe registrar su `ActiveArbitrageLock`. Si otra billetera de Helena intenta disparar un trade en el mismo rango de precio y sentido en los siguientes 6 segundos, el coordinador deniega la acción, protegiendo las reservas de gas de la cuenta.

---

## 3. Reducción de Venues y Optimización de la Infraestructura

Al usar módulos plug-and-play, es muy recomendable **reducir el número de venues** activos (por ejemplo, operando solo en 3 DEXs clave y 3 CEXs principales) para concentrar el capital. Sin embargo, la infraestructura debe estar dimensionada para tolerar la altísima demanda de actividad en estos mercados líquidos:

### 3.1. Foco en Venues Clave (Ejemplo de Círculo Optimizado)
*   **DEXs**: XRPL DEX, Jupiter (Solana) y Uniswap v4 (Arbitrum L2).
*   **CEXs**: Binance, Bybit y OKX.
*   *Ventaja*: En lugar de fragmentar $10,000 USD en 40 exchanges ($250 c/u), se concentran **$1,660 USD por exchange**, permitiendo trades que superan el tamaño de orden mínimo de las APIs y capturan spreads significativos.

### 3.2. Requisitos de Infraestructura de Alta Demanda
Para soportar la concurrencia de este círculo optimizado, el VPS debe cumplir con:
*   **CPU**: Mínimo 4 vCPUs (dedicadas, no compartidas) para procesar firmas criptográficas (ECDSA y Ed25519) en paralelo.
*   **Red**: Conexión de **1 Gbps** con baja latencia hacia los endpoints de WebSocket de Binance/Bybit (AWS Tokio o Fráncfort).
*   **Monitoreo del Event Loop**: El watchdog de Helena vigilará la latencia del bucle de eventos (`eventLoopDelay`). Si el delay supera los 50ms, desactivará temporalmente las cotizaciones secundarias para priorizar la ejecución de órdenes.

---

## 4. Estructura de Configuración Multi-Wallet

El archivo `.env` se configurará admitiendo múltiples semillas separadas por comas, asignando a cada wallet un rol o modo específico:

```env
# === CONFIGURACIÓN MULTI-WALLET (HELENA v2) ===
# Semillas para 3 cuentas activas en paralelo
XRPL_WALLET_SEEDS=sEdV3qkRMjNjbEHRd...,sEdT9yK...,sEdW3q...

# Asignación de Roles por Cuenta
WALLET_1_ROLE=MARKET_MAKER_TIGHT
WALLET_2_ROLE=MARKET_MAKER_STANDARD
WALLET_3_ROLE=ARBITRAGE_EXECUTOR

# Configuración de Servidor de Nodos Privado (Evitar Rate Limits)
XRPL_WS_URL=wss://tu-nodo-privado-dedicado.net:51233
SOLANA_RPC_URL=https://tu-nodo-solana-privado.net
```
