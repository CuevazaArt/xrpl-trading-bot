# 003 — Dorothy × Kyoto :: Sashimi

> **DCA Long (Acumulación) en XRPL DEX con XRP/USD**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 003 |
| **Nombre** | Dorothy × Kyoto :: Sashimi |
| **Estrategia** | Dorothy (Dollar Cost Averaging Long) |
| **Conector** | Kyoto (XRPL DEX) |
| **Activos** | Sashimi (XRP/USD) |
| **Estado** | ✅ Operativo (estrategia v1 en XRPL) |
| **Riesgo** | Bajo-Medio |
| **Capital mínimo** | 100 USD (trustline Bitstamp) |
| **Capital recomendado** | 500+ USD |

---

## ¿Qué hace?

Dorothy es una estrategia de **acumulación gradual** diseñada para comprar XRP en caídas de precio. Opera con un sistema de "rungs" (escalones): cada vez que el precio cae por debajo de un umbral, coloca una orden de compra. Cuando el precio sube, coloca un Take-Profit para vender con ganancia.

### Lógica de funcionamiento

```
Precio actual: $2.50

Rung 1: Comprar a $2.45 (-2%)  → TP a $2.57 (+5%)
Rung 2: Comprar a $2.40 (-4%)  → TP a $2.52 (+5%)
Rung 3: Comprar a $2.35 (-6%)  → TP a $2.47 (+5%)
...hasta max_rungs
```

### Compuertas de entrada

Dorothy NO compra ciegamente. Verifica:
1. **Tendencia alcista**: Precio sobre MA de largo plazo
2. **Entrada bajo apertura**: Precio actual < apertura de vela 1h (dip buying)
3. **Max rungs**: No excede el número máximo de posiciones abiertas

---

## Parámetros configurables

```bash
STRATEGY=dorothy

# Parámetros de Dorothy
DOROTHY_PROFIT_FACTOR=0.05       # Take-profit: 5% sobre precio de compra
DOROTHY_MARGIN_DROP_FACTOR=0.03  # Separación entre rungs: 3%
MAX_RUNGS=5                      # Máximo de posiciones simultáneas
DOROTHY_ORDER_AMOUNT_XRP=20      # XRP por rung

# Protecciones
MM_MAX_LOSS_USD=50.0             # Stop loss total
```

---

## Cuándo usar Dorothy

| Escenario | ¿Usar Dorothy? |
|-----------|:--------------:|
| Mercado lateral/bajista con expectativa bull | ✅ Ideal |
| Bull run confirmado | ⚠️ Compra poco (espera dips que no llegan) |
| Bear market prolongado | ⚠️ Acumula a precios que siguen cayendo |
| Volatilidad extrema | ✅ Compra los dips, vende los rebotes |

### Combinación recomendada

Dorothy funciona mejor como parte del portfolio **"Bento Box"** combinada con Helena (genera fees) y Louise (grids en rango).

---

## Archivos Relevantes

| Archivo | Descripción |
|---------|-------------|
| [dorothy.ts](file:///c:/Users/lexar/Desktop/xrpL/src/strategies/dorothy.ts) | Estrategia completa |
