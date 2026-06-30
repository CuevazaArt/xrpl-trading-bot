# Changelog

Todos los cambios notables en este proyecto serán documentados en este archivo.

## [2.4.0] - 2026-06-29
### Añadido
- **Escalabilidad HFT (100+ Instancias):** Migración completa a `worker_threads` nativos de Node.js, compartiendo el motor V8 de memoria y reduciendo el consumo de RAM para 100 instancias concurrentes a solo ~1.1 GB.
- **Almacenamiento SQLite WAL:** Sustitución de múltiples archivos `db.json` fragmentados por una base de datos centralizada en SQLite en modo WAL (`data/helena.db`), con soporte para consultas síncronas en caché y escrituras asíncronas concurrentes de fondo.
- **Aislamiento de Pruebas Unitarias:** Fallback automático al modo JSONDatabase y archivos planos en pruebas de Vitest (`NODE_ENV === 'test'`) para garantizar que la suite pase al 100% sin fugas de estado entre tests.
- **Oráculo Singleton Multiplexado:** Centralización del fetch de oráculos en el hilo principal de `stressTest.js` y transmisión del consenso de precios vía IPC (`worker.postMessage`) a los hilos de los bots, previniendo rate-limiting (`HTTP 429`).
- **Doctrina L0 (Juan / Cuevaza):** Creación de la documentación de doctrina de trading en [docs/DOCTRINA_TRADING.md](file:///c:/Users/lexar/Desktop/xrpL/docs/DOCTRINA_TRADING.md) consolidando los pilares de Soberanía, Cobertura Simétrica y Gestión de Pérdidas.
- **Telemetría MTMH Escalable:** Rediseño del orquestador de estrés para soportar 100 hilos, limitar visualmente a las primeras 30 instancias para evitar desbordes de pantalla, y persistir métricas JSON consolidadas en `data/stress_test_live_metrics.json`.

### Modificado
- Poda de logs periódicos repetitivos en Dorothy/Elphaba pasándolos a nivel `DEBUG`.
- Resolución del bucle de retroalimentación recursivo infinito en `LogMonitor`.

## [1.1.0] - 2026-06-26
### Añadido
- **Capa de Observación:** Implementación del Health Monitor que genera reportes periódicos del estado del bot.
- **Telegram Notifier:** Integración nativa con la API de Telegram para notificaciones instantáneas de trades y salud de fondos.
- **CLI Dashboard:** Interfaz interactiva en consola en tiempo real usando códigos ANSI y barras de progreso ASCII.
- **Simulador de Paper Trading:** Modos de prueba virtuales que interceptan transacciones reales y calculan métricas complejas (drawdown, win rate).
- **Typecheck & Robustez:** Tipados estrictos resueltos para el compilador de TypeScript en CI.

### Modificado
- Nivel de log por defecto en terminal cambiado a `INFO` para disminuir ruido visual.
- Los logs completos (`DEBUG`, `INFO`, `WARN`, `ERROR`) se escriben automáticamente en `data/app_raw.log`.

## [1.0.0] - 2026-06-25
### Añadido
- Versión inicial del bot de trading de arbitraje y market making para XRPL.
- Integración de MultiOracle para ponderación y filtrado de cotizaciones de exchanges de criptomonedas.
- Soporte para estrategias Dorothy DCA Long, Elphaba DCA Short y Louise DCA.
