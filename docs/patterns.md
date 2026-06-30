# Patrones y Antipatrones de Desarrollo (Helena XRPL Bot)

Este documento recopila las mejores prácticas (patrones) y errores comunes a evitar (antipatrones) descubiertos durante el desarrollo, despliegue y mitigación de riesgos de **Helena**.

---

## 🛡️ Patrones de Diseño e Implementación (Mejores Prácticas)

### 1. Dinamismo de Constantes Críticas (Configuración Descentralizada)
*   **Problema:** Hardcodear direcciones de emisores, tokens o credenciales de pasarela (como el emisor de USD Bitstamp) en múltiples archivos de estrategias.
*   **Solución (Patrón):** Centralizar estas variables en `src/config.ts` mapeándolas a variables del entorno (`process.env`). Todos los módulos y estrategias deben importar las variables dinámicas de este archivo centralizado.
    ```typescript
    // En src/config.ts
    usdIssuer: process.env.USD_ISSUER || 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'
    ```

### 2. Auto-Fondeo y Auto-Persistencia de Credenciales
*   **Problema:** La pérdida de claves privadas o direcciones generadas en caliente al apagar el contenedor o el servidor.
*   **Solución (Patrón):** Al inicializar la billetera por primera vez, si no existe una semilla válida en el entorno, guardar la semilla generada automáticamente en el archivo `.env` mediante escrituras síncronas controladas. Hacer lo mismo con los emisores generados por el script de fondeo.
    ```typescript
    // En src/walletManager.ts
    saveToEnv('XRPL_WALLET_SEED', this.wallet.seed);
    ```

### 3. Detención Segura por Caída de Oráculo (Halt-on-Failure)
*   **Problema:** Si el oráculo de precios spot (Coinbase) falla, el bot podría usar un precio estático de fallback (ej. `0.50 USD`) que difiera radicalmente del precio real del mercado, resultando en operaciones ruinosas por arbitraje en contra.
*   **Solución (Patrón):** Guardar en caché el último precio exitoso junto con su marca de tiempo. Si el oráculo falla:
    *   Si la caché es fresca (< 60 segundos), usarla.
    *   Si expira, detener (*halt*) por completo la ejecución de la estrategia retornando un precio de `0` o lanzando una suspensión segura.

### 4. Validación de Reservas y Buffers de XRP antes del Trading
*   **Problema:** Colocar órdenes sin saldo suficiente de XRP libre provoca errores de tipo `tecINSUFFICIENT_RESERVE` en la red XRPL, malgastando drops de comisión de red inútilmente.
*   **Solución (Patrón):** Antes de cada tick, calcular la reserva oficial del ledger (reserva de cuenta + reserva por objeto activo) más un buffer de seguridad (ej. 10 XRP). Si el balance libre no es suficiente, saltar el tick de trading.

### 5. Pool y Rotación de Endpoints WebSocket (Balanceo de Red)
*   **Problema:** Levantamiento de múltiples instancias concurrentes (como en tests de estrés con 24 bots) saturando los límites de conexión WebSocket por IP de un solo nodo público de XRPL, resultando en desconexiones inmediatas (`code: 1008`).
*   **Solución (Patrón):** Implementar un pool de múltiples endpoints RPC públicos válidos y pasar una lista rotada de dichos nodos a cada proceso de estrategia. Esto asegura que la carga inicial se distribuya uniformemente entre los servidores disponibles y provee una ruta de fallback redundante para reconexiones.

---

## ⚠️ Antipatrones a Evitar (Malas Prácticas)

### 1. Propagación de Excepciones de Red en Capas Internas (Crashes)
*   **Problema:** Dejar que fallas de red durante la preparación de la transacción (`autofill`) o el envío y espera (`submitAndWait`) propaguen excepciones asíncronas hacia las estrategias. Esto interrumpe el ciclo de ejecución del tick y puede tumbar el proceso de Node.js.
*   **Solución correctiva:** Capturar robustamente las excepciones en el `OrderManager` y devolver un objeto de estado controlado `{ success: false, error: error.message }` para que la estrategia pueda gestionarlo y continuar el ciclo en el siguiente ledger.

### 2. Asunción de Soporte de Arrays en Constructores de SDK
*   **Problema:** Pasar arrays o listas separadas por comas directamente a constructores de SDKs (ej: `new Client(urls)`) asumiendo que el SDK realiza failover automático nativo, lo cual provoca excepciones fatales de validación (`ValidationError`).
*   **Solución correctiva:** Parsear siempre las cadenas de configuración complejas en arrays en la capa de inicialización del bot (ej. en `src/index.ts`) y seleccionar estrictamente el primer endpoint válido de forma síncrona, dejando el fallback en manos de los reintentos manuales de conexión y el backoff exponencial.

### 3. Edición Directa de Base de Datos en Caliente desde el Exterior
*   **Problema:** Modificar o borrar el archivo `data/db.json` mientras el bot está ejecutándose.
*   **Solución correctiva:** Dado que el bot mantiene el estado de la base de datos en memoria antes de escribirlo de forma asíncrona, cualquier cambio al archivo externo será sobrescrito en el siguiente tick del bot. **El bot debe detenerse por completo antes de limpiar o alterar la base de datos.**

### 3. Redirección Estándar a NUL en Entornos Windows Restringidos
*   **Problema:** Ejecutar comandos de terminal asíncronos mediante runners que intentan redirigir la salida estándar a `NUL` con permisos excesivos (causando error `opening NUL for ACL write: Access is denied`).
*   **Solución correctiva:** Utilizar wrappers de comandos directos de Windows (`npm.cmd` o `npx.cmd`) o configurar políticas de bypass de ejecución (`Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process`) en el proceso local.

---

## 🔒 Patrones Nuevos de Producción y Endurecimiento (Helena v2)

### 1. Salida de Emergencia Controlada (Fail-Fast Exit) en Excepciones No Controladas
*   **Problema:** Dejar que un `uncaughtException` mantenga el proceso del bot de trading vivo. Un bot vivo después de una excepción inesperada puede estar operando con variables de estado corruptas, límites violados o hilos colgados, resultando en pérdidas de fondos catastróficas.
*   **Solución (Patrón):** Capturar la excepción globalmente, detener/cancelar órdenes activas mediante llamadas rápidas de red, enviar una alerta crítica prioritaria a Telegram y abortar el proceso inmediatamente mediante `process.exit(1)`. PM2 o Docker se encargarán del reinicio limpio desde cero.

### 2. Prevención de Incoherencia de Caché de Base de Datos
*   **Problema:** Leer/escribir de forma directa y externa el archivo `db.json` para realizar podas o revisiones de integridad mientras el bot está en ejecución. El bot mantiene una caché local (`db.data`) en memoria y sobrescribirá cualquier cambio externo en su siguiente llamada a `logTransaction()` o `logBalance()`.
*   **Solución (Patrón):** Todas las tareas de diagnóstico, validación de sintaxis, respaldos por corrupción y podas periódicas de datos antiguos deben delegarse al singleton central (`db`) a través de métodos encapsulados en memoria (`db.reloadAndValidate()` y `db.prune()`), sincronizando automáticamente los cambios en el disco de manera coherente y ordenada.

### 3. Caching de Consultas RPC de Configuración (Reserva de Red)
*   **Problema:** Invocar llamadas de red costosas (como `server_info`) en cada tick de ledger (~3 segundos) para calcular reservas requeridas. Esto sobrecarga el nodo RPC con unas 240 peticiones por minuto de información que casi nunca varía.
*   **Solución (Patrón):** Cachear los parámetros de reserva devueltos por `server_info` con un TTL alto (ej. 60 minutos). La reserva base y por objeto de la red XRPL cambia una vez al año; no es necesario sobrecargar el nodo.

### 4. Escrituras de Log Async sin Bloqueo de Event Loop
*   **Problema:** Usar `fs.appendFileSync` en el logger del bot para escribir cada traza. En trading de alta frecuencia (HFT), las llamadas síncronas a disco pueden bloquear el event loop de Node.js retrasando los ticks del bot y perdiendo el edge de precio.
*   **Solución (Patrón):** Deferir las escrituras a disco usando `setImmediate()` combinado con un try/catch controlado para que el guardado a disco se realice en la siguiente iteración del bucle de eventos, manteniendo la ejecución de la estrategia fluida e instantánea.

### 5. Watchdog de Ticks Colgados (Anti-Zombie)
*   **Problema:** Si el nodo RPC deja de responder a la mitad de una llamada de red de una estrategia y no hay un timeout estricto, el bot se quedará en un estado indefinidamente colgado (`tickInProgress = true`) sin hacer operaciones pero pareciendo estar vivo.
*   **Solución (Patrón):** Implementar un watchdog periódico e independiente que verifique el tiempo transcurrido desde el último tick exitoso. Si el tiempo excede un umbral (ej. 60 segundos), se emite una advertencia de tick inactivo y se reporta estado degradado o se detiene el proceso para forzar un reinicio de red.

### 6. Alertas Críticas con Límite de Frecuencia (Rate-Limiting)
*   **Problema:** Enviar mensajes o excepciones de error de red repetitivos a canales de Telegram en cada fallo asíncrono, saturando los límites de la API de Telegram (bloqueo por spam) y llenando el canal del usuario de ruido inútil.
*   **Solución (Patrón):** Implementar un cooldown de alertas críticas (ej. máximo 1 mensaje crítico por minuto) para consolidar fallos o suprimir spam repetitivo durante incidentes en cadena.
