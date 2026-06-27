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

---

## ⚠️ Antipatrones a Evitar (Malas Prácticas)

### 1. Propagación de Excepciones de Red en Capas Internas (Crashes)
*   **Problema:** Dejar que fallas de red durante la preparación de la transacción (`autofill`) o el envío y espera (`submitAndWait`) propaguen excepciones asíncronas hacia las estrategias. Esto interrumpe el ciclo de ejecución del tick y puede tumbar el proceso de Node.js.
*   **Solución correctiva:** Capturar robustamente las excepciones en el `OrderManager` y devolver un objeto de estado controlado `{ success: false, error: error.message }` para que la estrategia pueda gestionarlo y continuar el ciclo en el siguiente ledger.

### 2. Edición Directa de Base de Datos en Caliente desde el Exterior
*   **Problema:** Modificar o borrar el archivo `data/db.json` mientras el bot está ejecutándose.
*   **Solución correctiva:** Dado que el bot mantiene el estado de la base de datos en memoria antes de escribirlo de forma asíncrona, cualquier cambio al archivo externo será sobrescrito en el siguiente tick del bot. **El bot debe detenerse por completo antes de limpiar o alterar la base de datos.**

### 3. Redirección Estándar a NUL en Entornos Windows Restringidos
*   **Problema:** Ejecutar comandos de terminal asíncronos mediante runners que intentan redirigir la salida estándar a `NUL` con permisos excesivos (causando error `opening NUL for ACL write: Access is denied`).
*   **Solución correctiva:** Utilizar wrappers de comandos directos de Windows (`npm.cmd` o `npx.cmd`) o configurar políticas de bypass de ejecución (`Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process`) en el proceso local.
