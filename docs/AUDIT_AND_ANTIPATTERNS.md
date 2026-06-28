# 🛡️ Auditoría del Sistema: Errores, Antipatrones y Coherencia de Canales

Este documento registra los antipatrones, cuellos de botella y problemas de diseño detectados durante la auditoría de integración de **Helena** en el círculo de arbitraje, junto con directrices para garantizar la coherencia en producción.

---

## 1. Antipatrones Críticos Detectados y Soluciones

### 1.1. Acumulación Excesiva del `OwnerCount` (Fuga de Reservas de XRP)
*   **Antipatrón**: Reemplazar ofertas activas en el DEX colocando nuevas antes de que las previas se cancelen explícitamente en el ledger.
*   **Riesgo**: Cada oferta abierta incrementa el `OwnerCount` del usuario en 1, congelando **2 XRP** de reserva de la red por cada oferta. Si el bot realiza este reemplazo de forma errónea, la cuenta puede congelar rápidamente todo su balance de XRP disponible, parando las operaciones de trading.
*   **Solución**: Helena implementa el patrón **Cancel-Before-Replace** (Cancelar antes de colocar). El `OrderManager` consulta el listado de ofertas de la cuenta (`account_offers`) y cancela de forma activa todas las órdenes previas antes de enviar una nueva transacción `OfferCreate`.

### 1.2. Concurrencia de un solo hilo y Event Loop bloqueado (Node.js)
*   **Antipatrón**: Procesar las 40 conexiones de sockets (20 DEX + 20 CEX) en un único subproceso de Node.js compartiendo memoria global sin segregación.
*   **Riesgo**: Los ticks de cotizaciones y actualizaciones de libro de órdenes de alta velocidad saturarán el hilo de Node.js, retrasando la ejecución del bot. Una oportunidad de arbitraje detectada se firmará con precios de hace 2 segundos, resultando en pérdidas netas (*Stale Pricing / Deslizamiento Tóxico*).
*   **Solución**: Utilizar la arquitectura por microservicios detallada en `docs/MULTI_VENUE_ARBITRAGE_SCALING.md`. Cada venue se ejecuta en su propio subproceso o contenedor contenedorizado, enviando únicamente resúmenes rápidos a través de un bus de mensajes ultrarrápido (Redis Pub/Sub).

### 1.3. Excepciones no controladas de Red (Fallas de CEX/DEX)
*   **Antipatrón**: Propagar excepciones genéricas lanzadas por APIs REST o WebSockets rotos directamente al loop de trading principal.
*   **Riesgo**: Si la API de Binance o el nodo de QuickNode responde con un error HTTP 502 o un timeout, el bot sufre un crash fatal y deja órdenes límite flotando sin monitoreo en los libros.
*   **Solución**: Todos los adaptadores de Helena (`BinanceAdapter`, `MockCEXAdapter`, etc.) capturan internamente cualquier error HTTP/WebSocket y devuelven un objeto consistente `{ success: false, error: "Network Timeout" }`, permitiendo al `OrderManager` tomar decisiones de control y limpieza sin congelar la aplicación.

### 1.4. Bloqueos de Escritura E/S (JSON EPERM / Lock de Base de Datos)
*   **Antipatrón**: Escribir en `db.json` con alta frecuencia mediante llamadas de E/S síncronas concurrentes desde diferentes subprocesos de estrategias.
*   **Riesgo**: Ocurrirá un error de permisos del sistema de archivos (ej. `EPERM: operation not permitted, rename...`) al intentar sobrescribir el archivo mientras otro hilo lo tiene abierto para lectura, corrompiendo la base de datos de auditoría.
*   **Solución**: Helena implementa escrituras atómicas (escribiendo primero a un archivo `.tmp` temporal y renombrándolo después de forma asíncrona) y delega las escrituras a un canal con reintentos exponenciales. En entornos de alta demanda, se recomienda migrar la persistencia de datos de transacciones a una base de datos centralizada compatible con transacciones atómicas (como PostgreSQL).

---

## 2. Limitaciones en la Combinación de Canales (Venues)

No todos los DEX y CEX pueden combinarse de forma indiscriminada. Existen limitaciones estructurales que restringen los caminos de arbitraje rentables:

| Venue A (Fast) | Venue B (Slow) | Viabilidad | Limitante Principal / Comportamiento |
| :--- | :--- | :--- | :--- |
| **XRPL DEX** (3.5s block) | **Binance (CEX)** (Sub-ms) | **Alta** | Óptimo para arbitrajes rápidos y triangulación con pares IOU. |
| **Solana DEX** (400ms block) | **Ethereum DEX** (12s block) | **Muy Baja** | **Diferencia de Latencia**: Cuando la transacción en Ethereum se valida (12s), el spread en Solana ya habrá desaparecido debido al arbitraje local. Las tarifas de gas de Ethereum superarán los spreads típicos. |
| **DEX L2 (Base/Arbitrum)** | **Bybit (CEX)** | **Alta** | Óptima rentabilidad gracias a comisiones muy bajas (<$0.01) en L2 y APIs REST/WS eficientes. |

---

## 3. Guía de Consulta de Errores Operativos Comunes

*   **Error: `tefALREADY` (XRPL)**:
    *   *Causa*: El bot intentó enviar una transacción utilizando un número de secuencia (`Sequence`) que ya fue procesado por el ledger.
    *   *Acción*: Limpiar el mapa local de secuencias (`localSequenceMap`) y sincronizar el número de secuencia real consultando `account_info`.
*   **Error: `terQUEUED` (XRPL)**:
    *   *Causa*: La tarifa de red (fee) es demasiado baja para el estado de congestión actual o la secuencia de la transacción es futura.
    *   *Acción*: Dejar la transacción en cola; el ledger la procesará de forma automática en los siguientes bloques.
*   **Error: `Filter failure: MIN_NOTIONAL` (CEX)**:
    *   *Causa*: El bot intentó ejecutar una orden con un tamaño de capital inferior al mínimo permitido por el exchange (típicamente $5 o $10 USD).
    *   *Acción*: Incrementar el parámetro `tradeSize` en la configuración para superar el mínimo requerido por el exchange.
*   **Error: `API_RATE_LIMIT_EXCEEDED` (CEX)**:
    *   *Causa*: El bot excedió el número de solicitudes permitidas por minuto en la API del CEX.
    *   *Acción*: Ajustar los tiempos de tick y habilitar la caché de tickers (`AbstractCEXAdapter`) con un TTL mayor.

---

## 4. Directiva de Precisión de Decimales y Formatos Especiales

Para asegurar la coherencia en la adición de nuevos módulos, conectores o venues, se establece como **norma obligatoria** documentar y auditar los formatos de datos y precisiones numéricas requeridas por cada plataforma.

### 4.1. Regla de Registro Documental
Al integrar un nuevo venue, debes añadir en su correspondiente documentación (o cabecera del adaptador) una tabla especificando:
1.  **Precio (Tick Size)**: El número máximo de decimales permitidos y el incremento mínimo de precio (ej. `$0.0001` o 4 decimales).
2.  **Volumen (Lot Size / Step Size)**: El incremento de volumen mínimo (ej. `0.1` o 1 decimal) y la cantidad fraccionaria máxima.
3.  **Límite Nocional (Min Notional)**: El tamaño monetario mínimo que debe tener la orden para no ser rechazada.

### 4.2. Patrones y Antipatrones de Formateo
*   **Antipatrón (Flotantes Javascript)**: Enviar números directamente calculados por fórmulas matemáticas al CEX o DEX. Operaciones como `qty = balance / price` generan flotantes con 15 decimales debido al estándar IEEE 754 de punto flotante. Esto causa el rechazo inmediato de la orden en el 100% de los CEXs.
*   **Patrón DEX (Conversión a Drops / Escala Entera)**: En el DEX de XRPL, los montos en XRP deben expresarse siempre como un string que represente un entero en millonésimas de XRP (drops). El bot debe aplicar siempre `Math.round(volumeXrp * 1_000_000).toString()` antes de la firma. Nunca envíes flotantes con decimales al ledger.
*   **Patrón CEX (Truncamiento antes del Redondeo)**: No uses `Math.round()` genérico para volúmenes de CEX, ya que redondear hacia arriba puede exceder tu balance real disponible. Usa truncamiento hacia abajo (`Math.floor`) ajustado a la precisión permitida (ej: `Math.floor(qty * 10) / 10` para 1 decimal), garantizando que nunca intentes vender más tokens de los que tienes en balance.
