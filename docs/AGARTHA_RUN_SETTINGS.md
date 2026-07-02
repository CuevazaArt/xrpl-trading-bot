# Reporte de Configuración y Seguridad de la Corrida — Agartha Binance Spot

Este documento registra el diseño, los parámetros operacionales y la auditoría de seguridad para la corrida activa de la estrategia **Agartha** en el mercado Binance Alpha Spot.

---

## 🛡️ Auditoría de Seguridad de Credenciales

Hemos auditado la estructura de archivos local y el historial de seguimiento para verificar la protección de claves API:

1. **Aislamiento en `.env`**:
   * Las claves de la subcuenta dedicada (`BINANCE_API_KEY` y `BINANCE_API_SECRET`) están ubicadas exclusivamente dentro de tu archivo local `.env`.
   * El archivo `.env` está registrado en la línea 4 de [.gitignore](../.gitignore), lo que impide que Git lo rastree o lo suba al repositorio remoto de GitHub.
2. **Escaneo de Código**:
   * Ejecutamos escaneos de texto en todo el código fuente (`src/`) y la documentación (`docs/`) para verificar que las credenciales no estuvieran hardcodeadas en variables o comentarios. **Resultado: 100% Limpio (sin fugas)**.
3. **Ausencia de Archivos Temporales**:
   * Se verificó que no existan archivos residuales del sistema o copias de seguridad (como `.env.bak` o `.env.tmp`) expuestos en el directorio de trabajo.

---

## ⚙️ Especificaciones de la Corrida Activa (Seteo del Bot)

La instancia aislada de **Helena** corriendo bajo el proceso PM2 `helena-agartha-binance` ha sido inicializada con los siguientes parámetros particulares:

| Parámetro | Configuración | Propósito |
|-------|-------|-------|
| **Canasta de Activos** | 90 Símbolos Alpha | Obtenidos en vivo por API y filtrados localmente contra Binance Spot (ej. `RE`, `CHIP`, `OPN`, `WAL`, `MITO`, `AIXBT`, etc.) |
| **Nocional por Posición** | **10.0 USDT** | Tamaño fijo por orden de compra a mercado. |
| **Control de Capital** | **30 Posiciones** | Máximo de posiciones abiertas de forma simultánea. Limita la exposición de capital a **300 USDT** (315 USDT con buffer del 5%), protegiendo tu liquidez de 556.45 USDT. |
| **Trailing Entry** | **2.0%** | Rebote mínimo requerido desde el precio mínimo histórico del token para ejecutar la compra. |
| **Trailing Exit** | **3.0%** | Porcentaje máximo de caída tolerable desde el pico máximo alcanzado por el activo antes de liquidar a mercado. |
| **Activación de Trailing** | **1.5%** | Ganancia mínima que debe tocar el precio para "armar" el Trailing Stop. |
| **Beneficio Mínimo** | **1.0%** | Umbral bruto requerido para autorizar la liquidación por trailing (protección contra ventas en pérdidas por ruido menor). |
| **Time Stop** | **60 minutos** | Tiempo máximo de permanencia en una posición. Si se cumple, el bot liquida la posición a mercado para liberar capital estancado. |
| **Frecuencia de Ticks** | **10 segundos** | Intervalo de consulta de cotizaciones y evaluación de trailing. |
| **Base de Datos** | SQLite WAL | Ubicada en `data/helena.db` para persistencia duradera del estado de posiciones. |

---

## 🏷️ Control de Versiones y Tagging de Git

Esta versión instanciada de Agartha ha sido documentada y empaquetada. Para registrar los cambios locales y crear la etiqueta (**Git Tag**) de liberación oficial en tu repositorio remoto, ejecuta los siguientes comandos en tu terminal local:

```bash
# 1. Añadir los archivos de código y documentación actualizados
git add docs/ src/ package.json

# 2. Hacer commit de la versión estable
git commit -m "docs & feat: complete Agartha Binance Spot instance with dynamic catalog and capital control"

# 3. Crear el Tag de la versión instanciada
git tag -a v1.1.0-agartha-binance -m "Release v1.1.0: Instancia aislada Agartha Binance Spot con Catálogo Dinámico y Límite de Posiciones"

# 4. Empujar el commit y el Tag a GitHub
git push origin main
git push origin v1.1.0-agartha-binance
```
