# 007 — Helena × Zürich :: Tempura

> **Market Making en Uniswap V3 con WXRP/USDC — Baja Liquidez, Alto Spread**

---

## Ficha Técnica

| Campo | Valor |
|-------|-------|
| **ID** | 007 |
| **Nombre** | Helena × Zürich :: Tempura |
| **Estrategia** | Helena (Market Making) |
| **Conector** | Zürich (Uniswap V3 — Ethereum) |
| **Activos** | Tempura (WXRP/USDC) |
| **Estado** | 🔮 Requiere EvmConnector (Fase 8) |
| **Riesgo** | Alto (gas fees, impermanent loss, smart contract risk) |
| **Capital mínimo** | $500 (WXRP + USDC + ETH para gas) |
| **Capital recomendado** | $2,000+ |

---

## ¿Qué hace?

Helena opera como market maker en el pool de WXRP/USDC de Uniswap V3. Este pool tiene **baja liquidez** ($50-200K TVL), lo que significa:
- Spreads de **0.5-5%** (vs 0.01% en Binance)
- **Casi cero competencia** de bots especializados
- Oportunidades grandes pero infrecuentes

### ¿Por qué Tempura?

Tempura = ingrediente rebozado y frito. WXRP es XRP "wrapeado" (rebozado) para funcionar en Ethereum. El wrapping añade una capa pero preserva el sabor original.

### Modelo de operación

```
Helena en Uniswap NO usa el AMM pool directamente.
Opera colocando limit orders en Uniswap V3 (concentrated liquidity):

  Precio actual WXRP: $2.50

  Rango buy:  $2.40 - $2.48  (proveer USDC, recibir WXRP)
  Rango sell: $2.52 - $2.60  (proveer WXRP, recibir USDC)
  Spread: 1.6% (vs 0.3% en XRPL DEX)
```

---

## Consideraciones especiales

| Factor | Impacto | Mitigación |
|--------|---------|-----------|
| **Gas fees** | $5-50 por transacción | Solo operar cuando spread > gas cost |
| **Impermanent loss** | Pérdida si precio se mueve unidireccional | Rebalancear rangos frecuentemente |
| **Bridge risk** | Smart contract del bridge WXRP | Usar bridges auditados (Wormhole, Axelar) |
| **MEV / Sandwich attacks** | Bots front-run tu transacción | Usar Flashbots Protect RPC |

---

## Configuración `.env`

```bash
STRATEGY=market_maker
CONNECTOR=uniswap-v3
CHAIN=ethereum

# Wallet EVM
EVM_PRIVATE_KEY=0x...your_private_key
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/tu_key

# Tokens
WXRP_ADDRESS=0x...wxrp_contract
USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Helena ajustada para EVM
MM_ORDER_AMOUNT=200            # 200 WXRP por orden
MM_BASE_SPREAD=0.02            # 2% (compensar gas)
MM_MIN_GAS_GWEI=20             # No operar si gas > 20 gwei
MM_REBALANCE_THRESHOLD=0.05    # Rebalancear si desvía 5%

MM_MAX_LOSS_USD=100.0
```

---

## Dependencia

- Requiere: `EvmConnector` + `UniswapRouter` (Fase 8 del roadmap)
- SDK: `ethers.js` v6
- Infra: Nodo Ethereum (Alchemy/Infura)
