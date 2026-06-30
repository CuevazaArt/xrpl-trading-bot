# 📊 Matriz de Telemetría Multiproceso Helena (MTMH)

Este documento detalla la especificación, formato y valor de la **Matriz de Telemetría Multiproceso Helena (MTMH)**, la herramienta central de monitoreo utilizada por el operador para auditar la ejecución concurrente de múltiples instancias de Helena en tiempo real.

---

## 🎯 1. Propósito y Valor Operativo

Cuando Helena opera a gran escala (por ejemplo, con 24 instancias concurrentes en paralelo), el operador se enfrenta a una saturación de información. Analizar 24 consolas individuales de logs de forma manual es físicamente imposible.

La **MTMH** consolida la telemetría de todos los subprocesos activos en una única vista unificada y de alta frecuencia. Su valor reside en:
1.  **Diagnóstico Inmediato de Red**: Permite identificar qué servidores del pool de balanceo o gateways de tokens están fallando al verificar la columna `Err` e `ID`.
2.  **Monitoreo del Inventario y Liquidez**: Muestra los saldos disponibles simulados o reales por cada instancia para detectar si alguna estrategia se ha quedado "bloqueada" o sin liquidez (*dry spell*).
3.  **Auditoría de Actividad (Última Acción)**: Presenta la última acción relevante ejecutada por cada estrategia (ej: colocación de órdenes, cancelaciones, cierres de ciclos, o esperas preventivas), asegurando que el bot no esté en estado zombi.

---

## 📋 2. Estructura y Formato del MTMH

La matriz se renderiza dinámicamente en consola y se persiste de forma continua en `data/stress_test_live_metrics.json` con el siguiente formato:

```text
=============================================================================================================================================
 📊 MATRIZ DE TELEMETRÍA MULTIPROCESO HELENA (MTMH) — 24 Instancias Concurrentes
=============================================================================================================================================
ID | Estrategia       | Emisor / Gateway  | Ticks | Ord | Err | Saldo Disponible | Retorno P&L | Última Acción Operativa
---|------------------|-------------------|-------|-----|-----|------------------|-------------|----------------------------------------
00 | market_maker     | rvYAfWj5...4Eubs59B |    31 |   0 |   4 | $1000.90 USDT    | +0.09%      | Colocando COMPRA MM: 10 XRP a 1.0516...
01 | market_maker     | rhub8VRN...gmeqn14t |    22 |   0 | 792 | $1000.00 USDT    | +0.00%      | Error en escáner de arbitraje USD...
```

### Descripción de Columnas:
1.  **ID**: Índice secuencial de la instancia dentro del orquestador, útil para relacionar logs individuales (`data/stress_test_instance_ID.log`).
2.  **Estrategia**: El nombre de la estrategia de trading activa (ej. `market_maker`, `dorothy`, `elphaba`).
3.  **Emisor / Gateway**: La abreviatura del emisor del token IOU (Bitstamp, Gatehub, o Mock) con sus primeros 6 y últimos 8 caracteres para verificar la coherencia de red.
4.  **Ticks**: Cantidad total de ciclos/bloques del ledger que la estrategia ha procesado con éxito.
5.  **Ord (Órdenes)**: Número total de órdenes creadas o ejecutadas en la sesión.
6.  **Err (Errores)**: Alertas y excepciones capturadas por el vigilante de logs.
7.  **Saldo Disponible**: El saldo remanente actual del portafolio (ej. en USDT para el simulador, o el balance de XRP de la cuenta).
8.  **Retorno P&L**: El porcentaje de ganancia o pérdida acumulada realizada por la instancia (`+0.09%`).
9.  **Última Acción Operativa**: Un extracto en tiempo real de la última traza relevante del log de la estrategia, descartando trazas repetitivas de ruido para centrarse en acciones decisivas (colocaciones, cancelaciones, fallos de conexión).

---

## 🛠️ 3. Justificación de Decisiones Técnicas

*   **Persistencia en JSON en Vivo**: La tabla escribe su estado en disco en cada iteración del bucle de eventos (`data/stress_test_live_metrics.json`). Esto permite que herramientas externas de UI o servidores de visualización expongan la información sin acoplarse directamente al test de estrés.
*   **Filtrado de Watchdog y LogMonitor**: Se filtran los mensajes repetitivos generados por el watchdog de la salud interna del bot. Esto evita que la columna de "Última Acción" se llene de ruido informativo estático (como `Watchdog ciclo #4: OK`) y asegure mostrar solo trazas operativas útiles.
*   **Baja Latencia de I/O**: Toda la información de saldos y acciones se extrae de la caché interna y de las lecturas rápidas del stream del sistema de archivos, manteniendo el event loop de Node.js liberado de bloqueos de renderizado.
