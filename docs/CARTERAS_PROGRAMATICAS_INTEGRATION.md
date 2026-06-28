# 💼 Diseño de Integración: Carteras Programáticas y Estrategia de Capital Dinámico

Este documento detalla el diseño de integración para expandir la infraestructura de firmas y wallets en **Helena**, adoptando tecnologías modernas (EOA, MPC, Embedded Wallets y Account Abstraction) para la distribución de capital y la mitigación de "vías corruptas y tóxicas".

---

## 1. Mapeo de Tecnologías en el Ecosistema Helena

Para escalar Helena a múltiples cadenas y maximizar la seguridad, dividimos la arquitectura de carteras en cuatro niveles de especialización:

```
┌────────────────────────────────────────────────────────┐
│      1. Tesoro Central (MPC / Grado Institucional)     │
│   (Fireblocks / Coinbase CDP) — Controla el 90% Capital │
└───────────────────────────┬────────────────────────────┘
                            │ (Distribución Programática)
                            ▼
┌────────────────────────────────────────────────────────┐
│    2. Billeteras Inteligentes (Account Abstraction)   │
│   (Safe / Biconomy) — ERC-4337 con Session Keys en L2s │
└───────────────────────────┬────────────────────────────┘
                            │ (Ejecución Acotada)
                            ▼
┌────────────────────────────────────────────────────────┐
│     3. Ejecutores Locales de Latencia Ultra Baja       │
│       (EOA en Hot Memory) — xrpl.js, viem, solana-web3  │
└────────────────────────────────────────────────────────┘
```

### 1.1. EOA Locales: Ejecución en Caliente (Hot Memory)
*   **Rol**: Ejecución de swaps en milisegundos.
*   **Implementación**: Claves privadas locales gestionadas en memoria por el subproceso ejecutor, cargadas desde el vault cifrado localmente.

### 1.2. APIs de Custodia y MPC: El Tesoro Central (Treasury Vault)
*   **Rol**: Custodia principal del capital y rebalanceo entre redes.
*   **Implementación**: Coinbase Developer Platform (CDP) Wallet API o Fireblocks.
*   **Política de Seguridad (TAP)**: Ningún ejecutor de latencia (EOA) puede mover capital fuera del círculo comercial. El Tesoro Central tiene reglas firmadas on-chain que limitan los retiros externos a wallets corporativas multifirma (Multi-sig) aprobadas por directivos.

### 1.3. Account Abstraction (AA) y Claves de Sesión (Session Keys)
*   **Rol**: Autonomía segura para los bots de trading en EVM L2s.
*   **Implementación**: Smart Contracts (Safe/Biconomy).
*   **Lógica de Operación**: El bot firma usando una **Session Key** (clave de sesión) de corta duración (ej. 24 horas). Esta clave solo tiene permisos para:
    1. Interactuar con las direcciones de los pools autorizados (ej. Uniswap v4).
    2. Ejecutar transacciones con un límite máximo de $1,000 USD por bloque.
    *Si el servidor de la EOA local es hackeado, el atacante solo puede desviar un máximo de $1,000 USD antes de que la sesión expire o el contrato bloquee el balance.*

---

## 2. Flujo de Capital Dinámico: Distribuir y Concentrar

El sistema aplica una lógica de **"Exploración y Explotación"** para la asignación de liquidez:

```
[Capital en Tesoro Vault] ──> [Distribuye 5% en 10 Venues (Exploración)]
                                        │
                                        ▼ (Monitoreo de spreads y latencia)
                              [Identifica Venues con Spreads Óptimos]
                                        │
                                        ▼
                              [Concentra 80% Capital en Top 2 Venues]
```

1.  **Fase de Exploración (Distribución)**:
    El Tesoro Central distribuye fracciones pequeñas del portafolio (ej. 5% por venue) en las 40 plataformas para "testear" las oportunidades reales (DEX spreads, fees de transacción y velocidad de emparejamiento).
2.  **Fase de Concentración (Explotación)**:
    Una vez que el motor analítico de Helena confirma qué pares y venues tienen la mayor rentabilidad histórica y menor slippage en las últimas 12 horas, ordena de forma programática al Tesoro MPC redirigir el 80% de la liquidez libre a esas vías específicas.

---

## 3. Identificación y Registro de Vías Corruptas y Tóxicas

Para proteger el capital en entornos complejos, Helena implementará un **"Módulo de Reputación de Canales" (Channel Reputation Guard)** que detecta y cataloga las anomalías:

### 3.1. Tipos de Vías Identificadas:
*   **Vía Tóxica (Toxic Flow / MEV)**:
    *   *Detección*: El bot detecta que sus transacciones en un DEX sufren de *frontrunning* constante (ataques sandwich) o que la cotización final difiere más de un 0.3% de la cotización simulada debido a deslizamientos (slippage) maliciosos.
*   **Vía Corrupta (Stuck/Halted APIs)**:
    *   *Detección*: El endpoint WebSocket de un CEX sufre microcortes frecuentes, retrasos de respuesta en órdenes límite (>500ms) o aplica retenciones/bloqueos temporales en depósitos/retiros de XRP/USDT sin previo aviso.

### 3.2. Registro y Exclusión en la DB:
Cada incidente se reporta de forma atómica en la base de datos `db.json` bajo la estructura:
```json
{
  "timestamp": "2026-06-28T18:40:00Z",
  "type": "VENUE_ANOMALY",
  "venue": "Gate.io",
  "anomalyType": "API_DELAY_CRITICAL",
  "details": {
    "measuredDelayMs": 1250,
    "maxAllowedDelayMs": 300
  }
}
```

*   **Acción Correctiva Automatizada**: Si un Venue acumula 3 anomalías en 1 hora, su **Score de Reputación** cae por debajo del umbral de seguridad. El Core Solver de Helena lo **excluye de forma automática del grafo de rutas** de arbitraje y notifica por Telegram. El bot deja de operar en esa vía tóxica/corrupta hasta que pase una ventana de enfriamiento (cooldown) de 12 horas y se verifique su latencia.
