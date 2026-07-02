# Patrones y Antipatrones Operacionales — Agartha (Mercado Alpha)

Este documento compila el conocimiento de resiliencia, restricciones de red y gestión de riesgos adquirido a partir de la corrida activa de **Helena** y la base de datos de históricos y runbooks del clúster Agartha.

---

## ─── PATRONES DE DISEÑO Y EJECUCIÓN (BUENAS PRÁCTICAS) ───

### 1. Gestión de Trailing en Memoria + Persistencia Frecuente (State Checkpoint)
*   **Contexto**: Binance Alpha (y el subconjunto de Spot correspondiente) no ofrece órdenes nativas server-side de tipo `STOP_LOSS_LIMIT`, `OCO` o `TRAILING_STOP_MARKET`.
*   **Patrón**: La lógica de trailing stop (cálculo de `peakPrice` y `trailFloor`) debe vivir 100% en la memoria del bot. Este estado debe persistirse en la base de datos local (SQLite WAL) con alta frecuencia (idealmente cada tick de 10s) para asegurar que un crash del proceso no pierda el registro del pico máximo y rompa la protección de salida.

### 2. Reconciliación al Arranque (Recovery Boot / Gap Closing)
*   **Contexto**: Si el proceso cae (SIGKILL, pérdida de energía o mantenimiento) mientras el bot tiene posiciones abiertas, el mercado sigue moviéndose.
*   **Patrón**: Al iniciar el bot, se debe realizar un chequeo de recuperación:
    1. Cargar el último estado conocido de posiciones y `trailFloor` desde `data/helena.db`.
    2. Consultar el precio de mercado actual.
    3. Si el precio actual ya está por debajo del `trailFloor` calculado antes de la caída, **ejecutar la liquidación de inmediato en el primer tick** para evitar caídas catastróficas adicionales.

### 3. Mitigación de Comisiones CEX (Ajuste Dinámico de Balance Libre)
*   **Contexto**: Binance Spot deduce el **0.1% de comisión de trading** directamente del activo comprado. Si compramos $X$, el balance real libre disponible es ligeramente menor.
*   **Patrón**: Antes de colocar una orden de venta por Trailing Stop o Time Stop, consultar el balance real libre del token en el Spot wallet de Binance y ejecutar la venta por el valor mínimo:
    $$\text{Cantidad a Vender} = \min(\text{Cantidad en Memoria}, \text{Saldo Libre Real})$$
    Esto evita fallos críticos de tipo `Account has insufficient balance` durante liquidaciones.

### 4. Transacciones Idempotentes y Firmas Únicas (`client_order_id`)
*   **Contexto**: Reintentar una orden de compra o venta tras un timeout o fallo de red REST 5xx puede duplicar la orden en el exchange.
*   **Patrón**: Asignar un `client_order_id` único y determinista a la transacción en la DB local antes de enviarla. Si la red se cae, el bot puede consultar el estado exacto de la orden (`query_order`) utilizando ese ID único en el siguiente ciclo o reconcile boot para confirmar si entró al motor del exchange.

### 5. Tesis Pura de Trailing en Símbolos Alpha (Asimetría Positiva)
*   **Contexto**: Los activos del catálogo Alpha de Binance tienen altísima volatilidad.
*   **Patrón**: La estrategia debe depender exclusivamente del trailing stop dinámico desde el pico (`trailingExitPct`) y de un limitador temporal (`maxHoldingMinutes`). No se deben incorporar restricciones adicionales de ganancias mínimas (`minProfitPct`), stop loss fijos o lógicas de break-even. El bot asume y compensa pequeñas pérdidas potenciales con las ganancias masivas y asimétricas capturadas en los grandes "pumpeos".

### 6. Resiliencia ante Purgas Offline y Gestión de Estados Huérfanos
*   **Contexto**: Durante el mantenimiento del bot o al realizar purgas de base de datos para depurar configuraciones, los estados de posiciones activas se eliminan del almacenamiento local (SQLite). Sin embargo, los saldos físicos de los tokens (adquiridos por el bot en ciclos previos) siguen presentes en la billetera Spot de Binance.
*   **Patrón**: 
    1. **Restauración Asistida**: Ante una purga deliberada, se debe ejecutar un proceso de recuperación offline que lea los últimos estados registrados en logs (precio de entrada, cantidad, pico histórico) y los reinserte en la base de datos antes de reanudar el runner.
    2. **Control de Inventario**: El bot debe contar con un mecanismo de alerta de activos "huérfanos" (balances positivos del Spot Wallet para tokens Alpha que no tienen un estado registrado en memoria/DB) para evitar que posiciones queden sin la protección del trailing stop.

---

## ─── ANTIPATRONES OPERACIONALES (ERRORES A EVITAR) ───

### 1. ❌ Uso de Órdenes Nativas de Tipo STOP_LOSS/OCO en Alpha
*   **Antipatrón**: Configurar la estrategia esperando que el exchange gestione los disparadores de pérdida o trailing de forma automática.
*   **Impacto**: Las órdenes serán rechazadas por el motor de Binance Alpha (solo acepta tipo `LIMIT`).

### 2. ❌ Liquidaciones Estáticas sin Ajuste de Límites (`PERCENT_PRICE_BY_SIDE`)
*   **Antipatrón**: Colocar órdenes límite fijas de venta muy lejanas al precio actual durante crashes rápidos.
*   **Impacto**: Binance aplica reglas de banda de precio (`PERCENT_PRICE` bid 0.2x / ask 5x). Si el precio cae verticalmente y colocas una orden `LIMIT` de salida lejana, esta será rechazada por estar **fuera de banda**. Para Alpha, se deben usar órdenes `MARKET` o recalcular la límite al borde inferior de la banda permitida (`agartha_exit_planner`).

### 3. ❌ Asumir Fills del 100% de la Cantidad Teórica
*   **Antipatrón**: Intentar vender exactamente la cantidad guardada en la base de datos local sin verificar saldos.
*   **Impacto**: Rechazo sistemático de la venta (`insufficient balance`) y congelamiento del bot con pérdidas incrementales.

### 4. ❌ Evaluación y logs en ticks redundantes al límite de exposición
*   **Antipatrón**: Continuar consultando y logueando evaluaciones de compra de nuevos activos cuando el límite de posiciones (`AGARTHA_MAX_CONCURRENT_POSITIONS`) ya está lleno.
*   **Impacto**: Desperdicio de CPU y consumo innecesario de peso de API de Binance. El bot debe omitir las ramas de entrada de nuevos símbolos en cuanto alcance su límite de posiciones.

### 5. ❌ Introducción de Umbrales de Ganancia Mínima (`minProfitPct`) o Stop Loss Estáticos
*   **Antipatrón**: Configurar un valor de ganancia mínima (`minProfitPct`) para filtrar o bloquear el disparo del trailing stop.
*   **Impacto**: Si el trailing stop se activa a un porcentaje de ganancia relativamente bajo (ej. $+1.5\%$) y el precio retrocede, la ganancia en el piso de salida puede caer por debajo del umbral mínimo de profit. Al bloquear la salida, el bot mantiene la posición abierta perdiendo dinero indefinidamente en lugar de liquidar. Además, el uso de stop loss estáticos en mercados ultra-volátiles Alpha gatilla pérdidas frecuentes antes de que los activos inicien su fase de pumpeo.

