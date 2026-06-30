# 🧠 Doctrina y Filosofía de Inversión del Usuario (Juan / L0 / Cuevaza)

Este documento consolida el enfoque filosófico de trading, gestión de riesgo y doctrina operativa del usuario (identificado en los repositorios históricos y paralelos como **Juan**, **L0** o **Cuevaza**), extraído de los proyectos de backtesting e infraestructura:
*   [Pecunator-AccuMonetas](file:///C:/Users/lexar/.gemini/antigravity-ide/scratch/Pecunator-AccuMonetas)
*   [generikDBHistogramData](file:///C:/Users/lexar/Desktop/generikDBHistogramData)
*   [cvzBackTestForBotsInHistograms-1](file:///C:/Users/lexar/Desktop/cvzBackTestForBotsInHistograms-1)

---

## 📋 1. Los Principios Fundacionales de la Doctrina L0 (Juan)

Extraído del documento canónico de la Wiki de AccuMonetas: [L0-Operator-Philosophy.md](file:///C:/Users/lexar/.gemini/antigravity-ide/scratch/Pecunator-AccuMonetas/wiki/L0-Operator-Philosophy.md).

### 1.1 Optimismo Estructural (Long-Only Bias)
El operador tiene un sesgo alcista de largo plazo sobre el mercado cripto. El sistema se diseña principalmente para **acumular, retener y componer** activos, no para operar en corto (*shorting*) de manera pura (salvo coberturas transitorias específicas).

### 1.2 Velocidad de Capital (Never Idle)
El dinero ocioso en balance es un costo de oportunidad inaceptable. Todo el capital debe estar distribuido en:
*   **Posiciones activas** (bots de trading).
*   **Servicios de renta pasiva** (Binance Earn o Staking).
*   **Órdenes de acumulación** (DCA regular).
*   *Excepción (Dry Powder)*: Se tolera una reserva del 10-20% en stablecoins como "opcionalidad" ante caídas abruptas de mercado.

### 1.3 Micro-Atomización de Operaciones
El operador prefiere fragmentar el capital en **múltiples posiciones muy pequeñas** en la mayor cantidad de símbolos posibles, utilizando el tamaño de orden mínimo permitido por el exchange.
*   *Ventaja*: Disuelve el riesgo individual y genera un flujo continuo de retroalimentación empírica en vez de apostar a pocos activos grandes.

### 1.4 Experimentación Holística (MVE Protocol)
Filosofía de exposición abierta: probar cada herramienta, indicador, método y preset. Lo útil se integra, lo obsoleto se descarta.
*   *Protocolo MVE (Minimum Viable Experiment)*: Cada experimento dura mínimo 30 días o 200 ciclos, con metas de Sharpe > 0, win rate > 40% y drawdown < 20%.

### 1.5 Parámetro Anti-Dogma
> *"Todos los principios son preferencias del operador, no leyes fijas. Están sujetos a evolución orgánica y revisión basada en los datos empíricos de ejecución."*

---

## 📊 2. Filosofía Operativa HODL + Earn (Modelo Cíclico)

Extraído de las especificaciones de bots en la biblioteca de backtest de [generikDBHistogramData/library/bots/louise/notes.md](file:///C:/Users/lexar/Desktop/generikDBHistogramData/library/bots/louise/notes.md) y [dorothy/notes.md](file:///C:/Users/lexar/Desktop/generikDBHistogramData/library/bots/dorothy/notes.md):

1.  **Criterio de Éxito No-Monetario**: El fin principal de los bots DCA no es maximizar el balance nominal de USDT a corto plazo, sino:
    *   Acumular cantidades físicas del activo de alta convicción (BTC, ETH, SOL, BNB, XRP) a precios promedio razonables.
    *   Extraer cash (USDT) en oscilaciones favorables intermedias.
2.  **Graduación a Earn (Bags Underwater)**:
    *   Dado que se opera en **Spot sin apalancamiento**, un drawdown severo del 40% no causa liquidaciones.
    *   *Mecanismo*: Si un bot acumula el máximo de compras grilla (`max_rungs`) y queda atrapado en una caída prolongada (*bag underwater*), los activos acumulados se gradúan e ingresan a **Binance Earn Flexible**. Allí generan APY pasivo (renta) mientras se espera a que el ciclo del mercado se recupere.
3.  **Ciclos de Acumulación**:
    *   Estrategias avanzadas como la nueva **Louise** en AccuMonetas operan sin Take Profit en P&L para salir. Compran a la baja hasta alcanzar una meta física (`cycle_accumulation_target` ej. 0.5 BTC), transfieren a Earn Flexible para capitalizarse, y reinician la acumulación desde cero.

---

## ⚙️ 3. El Fin Último de la Herramienta (Tesis Técnica)

Extraído de la directiva obligatoria número 7 del `README.md` de [generikDBHistogramData](file:///C:/Users/lexar/Desktop/generikDBHistogramData/README.md#L24):

> *"El fin último de la herramienta es la búsqueda y desarrollo de **artefactos** (bots, presets, datasets curados, indicadores) que ayuden a generar los **mayores beneficios posibles en el menor tiempo posible**. Toda decisión técnica (base de datos, motor de simulación, persistencia, paralelismo) se prioriza bajo este único criterio."*

---

## 🛡️ 4. Exposición y Stop-Loss por Niveles (Tiers)

El stop-loss en la doctrina L0 es dinámico y depende de la calidad fundamental del activo:

*   **Tier A (Blue Chips - BTC, ETH, SOL, BNB, XRP)**: Stop-loss muy amplio o desactivado (HODL perpetuo + Earn flexible). Se asume la depreciación temporal como impermanente.
*   **Tier B (Layer-2 / Emergentes - ARB, OP, MATIC)**: Stop-loss activo configurado en un rango estricto del **15% al 25%**.
*   **Tier C (Especulativos / Meme Coins)**: Atención mínima y stop-loss dinámico (*trailing stop*) muy ajustado del **5% al 10%** para evitar capitulaciones rápidas de capital.
