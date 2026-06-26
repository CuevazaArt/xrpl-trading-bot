# Changelog

Todos los cambios notables en este proyecto serán documentados en este archivo.

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
