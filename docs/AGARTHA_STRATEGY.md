# 🏛️ Estrategia Agartha — Moonshot Trailing (Volatile Asset Trend)

**Agartha** es un algoritmo de **seguimiento de tendencias exponenciales (Trailing Stop)** diseñado específicamente para operar activos altamente volátiles de baja capitalización (tokens del sector Alpha, como `FARM`, `POND`, `BOB`, `TA`, etc.). 

El objetivo principal de Agartha es capturar el recorrido máximo de pumpeos verticales repentinos y liquidar la posición de manera automatizada ante la primera señal de retroceso, recortando pérdidas rápidamente si el pumpeo falla.

---

## ⚙️ Parámetros de Configuración (.env)

Para operar de forma segura, Agartha requiere definir parámetros de aislamiento y selección de tokens:

| Variable | Valor Recomendado | Descripción |
| :--- | :---: | :--- |
| `STRATEGY` | `agartha` | Activa la estrategia Agartha en Helena. |
| `AGARTHA_ASSET_CODE` | `FARM` | Símbolo del token volátil a operar en el DEX de XRPL (IOU). |
| `AGARTHA_ASSET_ISSUER` | `rMoZZ...` | Cuenta emisora oficial del token IOU en el XRP Ledger. |
| `AGARTHA_CEX_ORACLE` | `FARMUSDT` | Par del oráculo en Binance Spot para cotización ultra veloz. |
| `AGARTHA_BUDGET_USD` | `100.0` | **Presupuesto Aislado** de capital máximo en USD dedicado a esta posición. |
| `AGARTHA_ACTIVATION_PROFIT_PCT`| `10.0` (10%) | Porcentaje de ganancia necesario para activar el rastreo del Trailing Stop. |
| `AGARTHA_TRAILING_STOP_PCT` | `15.0` (15%) | Margen de caída máxima permitida desde el pico antes de liquidar. |
| `AGARTHA_ENTRY_LIMIT_OFFSET_PCT`| `2.0` (2%) | Descuento límite para la compra de entrada. Si es `0`, entra a mercado. |
| `AGARTHA_MAX_HOLDING_LEDGERS` | `1000` (~1 hora) | **Time Stop**: Límite de bloques para liquidar la posición si el precio se estanca. |

---

## 🔄 Flujo Operativo y Trailing Stop

```mermaid
graph TD
    A[Inicio del Tick] --> B[Consultar Ticker en Binance API CEX Oracle]
    B --> C{¿Hay posición activa?}
    C -- No --> D[Colocar Compra Límite de Entrada con Descuento o Mercado]
    C -- Sí --> E[Actualizar Precio Pico peakPrice]
    E --> F{¿Trailing Stop está activo?}
    F -- No --> G{¿peakPrice >= entryPrice * 1 + ActivationPct?}
    G -- Sí --> H[Activar Trailing Stop = true]
    G -- No --> I[Seguir Rastreando]
    F -- Sí --> J{¿Precio actual <= peakPrice * 1 - TrailingStopPct?}
    J -- Sí --> K[Liquidar posición a mercado y registrar ganancias/pérdidas]
    J -- No --> I
```

1.  **Detección a Alta Velocidad**: El bot no utiliza el feed del ledger para el precio de referencia, sino que consulta directamente la API Spot de Binance (`AGARTHA_CEX_ORACLE`) en cada tick para reaccionar a las mechas en milisegundos.
2.  **Entrada Límite o Spot**: Coloca una oferta de compra por el equivalente de `AGARTHA_BUDGET_USD` en el token elegido.
3.  **Activación de Trailing**: Si el token sube un **10%** desde el precio de compra, se activa el seguimiento dinámico.
4.  **Toma de Ganancias / Salida**: Si el precio del token sube un 80% y luego retrocede un **15%** (`AGARTHA_TRAILING_STOP_PCT`), el bot vende inmediatamente toda la posición, bloqueando la ganancia.
5.  **Aislamiento Financiero**: Agartha calcula los volúmenes y costes usando únicamente su presupuesto asignado `AGARTHA_BUDGET_USD`, garantizando que sus pérdidas o retenciones de saldo no afecten la liquidez del motor de arbitraje de Helena.

---

## 🛡️ Persistencia y Auditoría de Transacciones (DB Local)

La base de datos local `db.json` registra los siguientes identificadores para el seguimiento de Agartha:

*   `AGARTHA_ENTRY_LIMIT`: Colocación de la orden de entrada con descuento.
*   `AGARTHA_LIMIT_FILLED`: Llenado de la orden límite y apertura de la posición.
*   `AGARTHA_BUY`: Compra de entrada ejecutada directamente a mercado.
*   `AGARTHA_LIQUIDATED`: Liquidación y cierre de la posición (ya sea por `TRAILING_EXIT` o `TIME_STOP`).
