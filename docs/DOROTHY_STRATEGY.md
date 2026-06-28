# 👧 Estrategia Dorothy — DCA Long Oportunista en XRPL

**Dorothy** es un algoritmo de **DCA (Dollar Cost Averaging) Long** opportunista. Está diseñada para operar de forma desatendida en el DEX de XRP Ledger, acumulando posiciones de XRP a precios de descuento durante micro-tendencias alcistas y cerrando ganancias de forma escalonada con órdenes de Take Profit (TP) individuales.

---

## ⚙️ Parámetros de Configuración (.env)

| Variable | Valor Recomendado | Descripción |
| :--- | :---: | :--- |
| `STRATEGY` | `dorothy` | Habilita esta estrategia en Helena. |
| `DOROTHY_PROFIT_FACTOR` | `0.03` (3%) | Porcentaje de Take Profit para cada peldaño. |
| `DOROTHY_MARGIN_DROP_FACTOR` | `0.025` (2.5%) | Caída requerida desde el último peldaño para abrir el siguiente. |
| `MAX_RUNGS` | `4` | Cantidad máxima de peldaños (compras de acumulación) simultáneos. |
| `RUNG_QTY_XRP` | `15` | Volumen de XRP a operar por cada peldaño de acumulación. |

---

## 📈 Lógica de Compuertas e Inteligencia de Entrada

Para mitigar compras en máximos locales (*Adverse Selection*), Dorothy verifica dos compuertas antes de comprar:

1.  **Compuerta de Tendencia (Trend Gate - Heikin-Ashi)**:
    *   Consulta velas de 1h del par `XRP/USDT` a través de un pool de oráculos.
    *   Solo permite comprar si el Heikin-Ashi Close es superior al Heikin-Ashi Open, asegurando que el mercado tiene inercia alcista.
2.  **Compuerta de Entrada (Entry Gate - Pullback)**:
    *   Compara el precio de mercado actual con el precio de apertura de la vela de 1h actual.
    *   Solo permite comprar si `marketPrice < candleOpen1h`, garantizando que compramos durante un retroceso (pullback) dentro de la tendencia alcista.

### 🌐 Pool de Oráculos Resilientes (Fallbacks)
Si la API principal falla, Dorothy conmuta automáticamente en milisegundos:
1.  **Binance API**: Oráculo primario.
2.  **Kraken API**: Primer respaldo ante rate-limits.
3.  **CryptoCompare API**: Segundo respaldo.
4.  *Entrada de Seguridad*: Si todos los oráculos fallan, permite la entrada por defecto para no bloquear la ejecución del bot.

---

## 🛡️ Robustez, Formato y Precisión de Órdenes

De acuerdo con las directivas de robustez de Helena, Dorothy aplica el siguiente tratamiento a los formatos de las órdenes:

### A. Escala de Drops Enteros en DEX (XRPL)
*   **Volumen de Compra/Venta**: No envía decimales flotantes al ledger. Todos los montos de XRP se transforman a gotas enteras mediante:
    `const takerPays = (buyQtyXrp * 1_000_000).toString();`
*   **Precios de Take Profit**: Los precios se truncan estrictamente a 4 decimales:
    `const sellPrice = parseFloat((marketPrice * (1 + profitFactor)).toFixed(4));`

### B. Evitar Posiciones Huérfanas (Orphaned Rungs)
*   **Problema**: Si la orden de compra a mercado es exitosa pero la colocación de la orden de venta límite de Take Profit (TP) falla (por ejemplo, por comisiones o desconexión), la posición de XRP queda "huérfana" e indocumentada en la base de datos.
*   **Solución**: Si el TP falla, Dorothy marca el peldaño con el estado `ORPHANED` en `db.json` y notifica al operador de inmediato en los logs para que tome control manual de esa porción de inventario.

---

## 📝 Registro de Auditoría de Transacciones (DB Local)

Dorothy registra de forma estructurada los siguientes eventos en la base de datos local:

*   `DOROTHY_COMPRA`: Registrado tras realizar la compra de acumulación exitosa.
*   `DOROTHY_TP_LIMIT`: Registrado al colocar la orden de venta límite (Take Profit) en el DEX.
*   `DOROTHY_TP_FILLED`: Registrado en el ciclo en que se detecta que la orden de venta ya no está activa en el ledger (cierre del ciclo de ganancia).
*   `DOROTHY_TP_FALLIDA_HUERFANA`: Registrado en caso de que la compra se complete pero la orden límite de TP sea rechazada.
