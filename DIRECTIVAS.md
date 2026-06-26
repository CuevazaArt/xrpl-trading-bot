# Directivas de Desarrollo y Patrones

Este documento define las directivas locales, patrones y antipatrones de diseño acordados para la evolución técnica del Bot de Trading XRPL.

## 1. Patrones de Diseño

### 1.1 Singleton Database
- La base de datos local JSON (`JSONDatabase`) se expone como una instancia única exportada (`db` en `db.ts`).
- **Directiva:** No crear múltiples instancias de `JSONDatabase`. Importar siempre `db` para garantizar la coherencia de escrituras asíncronas concurrentes.

### 1.2 Consenso Multifuente (MultiOracle)
- La cotización de XRP/USD no debe depender de un solo exchange para evitar manipulaciones de precio y caídas.
- **Directiva:** Utilizar siempre `MultiOracle` para obtener precios filtrados por mediana y spread de consenso.

### 1.3 Inyección de OrderManager
- Para dar soporte a Paper Trading sin duplicar código, las estrategias deben recibir el manager de órdenes por parámetro en su constructor.
- **Directiva:** Utilizar la clase base `XRPLOrderManager` como tipo. El bot inyectará transparentemente `PaperOrderManager` en simulaciones o `XRPLOrderManager` real en producción.

---

## 2. Antipatrones a Evitar

### 2.1 Peticiones Redundantes o Muertas (Antipatrón)
- Realizar consultas repetitivas a APIs de exchanges (como Binance o CryptoCompare) cuando el token de API no está configurado.
- **Directiva:** Validar credenciales antes de programar ticks de consulta y excluir del MultiOracle fuentes vacías para prevenir advertencias de errores HTTP 401/403 recurrentes en consola.

### 2.2 Bloqueo del Event Loop por Archivos (Antipatrón)
- Usar métodos síncronos de lectura/escritura (`fs.writeFileSync`, `fs.readFileSync`) dentro del ciclo caliente del bot (ticks de ledger).
- **Directiva:** Utilizar siempre el módulo asíncrono de promesas (`fs/promises`) y encolar las escrituras en colas secuenciales para evitar condiciones de carrera al guardar logs o base de datos.
