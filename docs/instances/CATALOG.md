# Catálogo de Instancias — Trading Platform

## Convención de Nombres

| Componente | Categoría | Ejemplo |
|-----------|-----------|---------|
| **Estrategia** | Nombres de mujer | Helena, Dorothy, Agartha... |
| **Conector** | Ciudades del mundo | Kyoto, Shanghai, Zürich... |
| **Grupo de activos** | Platillos culinarios | Sashimi, Ratatouille, Ceviche... |

**Formato**: `Estrategia × Ciudad :: Platillo`
**Ejemplo**: `Helena × Kyoto :: Sashimi` = Market Making en XRPL DEX con XRP/USD

---

## Conectores (Ciudades)

| Ciudad | Exchange | Cluster | SDK | Estado |
|--------|----------|---------|-----|:------:|
| **Kyoto** 🏯 | XRPL DEX | xrpl | xrpl.js | ✅ Operativo |
| **Shanghai** 🏙️ | Binance | cex | REST/WS | ✅ Conector existe |
| **Bergen** 🏔️ | Kraken | cex | REST | 🟡 Solo oracle |
| **Denver** 🏜️ | Coinbase | cex | REST | 🟡 Solo oracle |
| **Zürich** 🏦 | Uniswap V3 | evm | ethers.js | 🔮 Planificado |
| **Bangkok** 🛕 | PancakeSwap | evm | ethers.js | 🔮 Planificado |
| **Lima** 🌄 | Jupiter (Solana) | solana | @solana/web3.js | 🔮 Planificado |

---

## Grupos de Activos (Platillos)

| Platillo | Par | Descripción |
|----------|-----|-------------|
| **Sashimi** 🍣 | XRP/USD | XRP nativo, puro, sin wrapping |
| **Nigiri** 🍱 | XRP/USDT | XRP en CEX con stablecoin Tether |
| **Tempura** 🍤 | WXRP/USDC | XRP wrapeado en EVM (frito = wrapeado) |
| **Wagyu** 🥩 | BTC/USDT | Bitcoin, el activo premium |
| **Ratatouille** 🥘 | ETH/USDT | Ethereum, complejo y multicapa |
| **Ceviche** 🐟 | SOL/USDC | Solana, fresco y rápido |
| **Paella** 🥘 | Multi-asset | Múltiples activos combinados |
| **Dim Sum** 🥟 | Altcoins/USDT | Canasta de altcoins variados |

---

## Instancias Desarrolladas

### ✅ Operativas

| ID | Nombre | Estrategia | Conector | Activos | Ficha |
|----|--------|-----------|----------|---------|:-----:|
| 001 | **Helena × Kyoto :: Sashimi** | Helena (MM + IOC) | Kyoto (XRPL DEX) | Sashimi (XRP/USD) | [📄](./instances/001_helena_kyoto_sashimi.md) |

### 🔜 Próximas

| ID | Nombre | Estrategia | Conector | Activos |
|----|--------|-----------|----------|---------|
| 002 | **Helena × Shanghai :: Nigiri** | Helena (MM) | Shanghai (Binance) | Nigiri (XRP/USDT) |
| 003 | **Dorothy × Kyoto :: Sashimi** | Dorothy (DCA Long) | Kyoto (XRPL DEX) | Sashimi (XRP/USD) |
| 004 | **Dorothy × Shanghai :: Wagyu** | Dorothy (DCA Long) | Shanghai (Binance) | Wagyu (BTC/USDT) |
| 005 | **Agartha × Shanghai :: Ratatouille** | Agartha (Trailing) | Shanghai (Binance) | Ratatouille (ETH/USDT) |
| 006 | **Arbitrage × Kyoto↔Shanghai :: Sashimi** | Arbitrage (2-leg) | Kyoto ↔ Shanghai | Sashimi (XRP) |

### 🔮 Futuras

| ID | Nombre | Estrategia | Conector | Activos |
|----|--------|-----------|----------|---------|
| 007 | **Helena × Zürich :: Tempura** | Helena (MM) | Zürich (Uniswap) | Tempura (WXRP/USDC) |
| 008 | **Helena × Bangkok :: Tempura** | Helena (MM) | Bangkok (PancakeSwap) | Tempura (WXRP/USDC) |
| 009 | **Agartha × Lima :: Ceviche** | Agartha (Trailing) | Lima (Jupiter) | Ceviche (SOL/USDC) |
| 010 | **Louise × Shanghai :: Nigiri** | Louise (Grid Long) | Shanghai (Binance) | Nigiri (XRP/USDT) |
| 011 | **Masha × Denver :: Ratatouille** | Masha (MA) | Denver (Coinbase) | Ratatouille (ETH/USD) |
| 012 | **Thusnelda × Shanghai :: Paella** | Thusnelda (Multi) | Shanghai (Binance) | Paella (Multi-asset) |

---

## Portfolios Pre-configurados

### 🟢 Conservador: "Bento Box" 🍱
```
40% — Dorothy × Kyoto :: Sashimi     (DCA en caídas de XRP)
30% — Helena × Kyoto :: Sashimi      (MM para fees)
30% — Louise × Shanghai :: Nigiri    (Grid en rango)
```

### 🟡 Balanceado: "Omakase" 🍽️
```
25% — Arbitrage × Kyoto↔Shanghai     (Arb cross-venue)
25% — Dorothy × Shanghai :: Wagyu    (DCA Bitcoin)
25% — Helena × Kyoto :: Sashimi      (MM en DEX)
25% — Agartha × Shanghai :: Ratatouille (Trailing ETH)
```

### 🔴 Agresivo: "Street Food Tour" 🌮
```
30% — Helena × Zürich :: Tempura     (MM baja liquidez EVM)
25% — Helena × Bangkok :: Tempura    (MM baja liquidez BSC)
25% — Arbitrage × Kyoto↔Shanghai     (Arb cross-venue)
20% — Agartha × Lima :: Ceviche      (Trailing Solana)
```
