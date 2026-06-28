# 📋 Lista de Chequeo para Integración de DEXs y CEXs en el Círculo de Arbitraje

Este documento detalla los requisitos técnicos, credenciales y preparativos que el usuario debe resolver para conectar nuevos exchanges (DEXs/CEXs) al motor de arbitraje de **Helena**.

---

## 1. Requisitos para CEXs (Exchanges Centralizados)

Integrar un CEX (como **Binance**, **Kraken** o **Coinbase**) requiere configurar credenciales seguras y saldo disponible para hedging.

### ☐ 1.1. Gestión de API Keys y Seguridad (Principio de Menor Privilegio)
*   **Permiso de Lectura**: Habilitado (requerido para consultar balances y libros de órdenes).
*   **Permiso de Trading (Spot/Futures)**: Habilitado (requerido para ejecutar coberturas).
*   **Permiso de Retiros (Withdrawals)**: 🚫 **SIEMPRE DESACTIVADO**. Helena nunca debe tener acceso a retirar fondos del CEX.
*   **Restricción de IP**: Configurar en el CEX la whitelist de IPs permitiendo únicamente la dirección IP pública del VPS o servidor Docker donde corre Helena.

### ☐ 1.2. Fondeo y Estructura de Margen (Perpetuos)
*   **Margen Mínimo**: Depositar colateral suficiente en la billetera de futuros (USDT/USDC) para evitar llamadas de margen (*margin calls*) o liquidaciones durante ráfagas de arbitraje.
*   **Configuración de Apalancamiento**: Establecer un apalancamiento moderado (recomendado: 1x a 5x, máximo 10x) en el panel del CEX antes de conectar el bot.
*   **Tipo de Margen**: Configurar en modo **Margen Aislado** por par para limitar pérdidas si ocurre un fallo catastrófico en un solo mercado.

---

## 2. Requisitos para DEXs basados en EVM (Uniswap, Curve, 1inch)

Operar en redes EVM (Ethereum, Arbitrum, Optimism, Base, Polygon) requiere billeteras locales, saldo de gas y aprobación de contratos.

### ☐ 2.1. Gestión de Llaves y Gas (Gas Tokens)
*   **Llave Privada (Private Key)**: Configurar la clave privada de una billetera EVM dedicada exclusivamente al bot (nunca usar tu cuenta personal de ahorros DeFi).
*   **Saldo para Gas**: Mantener un saldo mínimo de gas en la red correspondiente:
    *   Arbitrum / Optimism / Base: ~0.005 ETH a 0.01 ETH.
    *   Polygon: ~10 MATIC / POL.
    *   Ethereum Mainnet: ~0.05 ETH (evitar arbitrajes aquí por costos prohibitivos).

### ☐ 2.2. Aprobaciones de Tokens (Token Approvals)
*   **Approve Infinito / Limitado**: Antes de que el bot intente operar, se debe ejecutar una transacción de aprobación (`approve`) desde la billetera al Smart Contract del Router (ej. Uniswap Router o 1inch Router) para permitir el gasto de los tokens a intercambiar (USDC, USDT, WBTC, etc.).
*   *Nota: El adaptador debe comprobar si existe aprobación y alertar si falta.*

### ☐ 2.3. Acceso a Nodos (Endpoints RPC)
*   **RPC de Baja Latencia**: No usar RPCs públicos gratuitos (ya que limitan la frecuencia y sufren de cortes). Utilizar proveedores con planes de desarrollador gratuitos o de pago (como Alchemy, QuickNode o Infura) y configurar la URL en el archivo `.env`.

---

## 3. Requisitos para DEXs de Solana (Jupiter, Raydium, Orca)

### ☐ 3.1. Requisitos de Wallet y Alquiler (Rent)
*   **Solana Keypair**: Proveer la clave privada de Solana en formato array JSON (código de bytes de la clave privada de Phantom/Solflare) o archivo de clave (`id.json`).
*   **Reserva de SOL (Gas + Rent Exemption)**: Mantener al menos **0.1 SOL** en la billetera para pagar tarifas de gas y la renta de creación de cuentas de tokens asociadas (Associated Token Accounts - ATA).

### ☐ 3.2. Cuentas de Tokens Asociadas (ATAs)
*   Crear previamente las cuentas de token (ATA) para los tokens a arbitrar (ej. USDC, USDT) utilizando la terminal o el explorador para evitar que el bot gaste computación extra y tarifas de creación de cuentas en transacciones de tiempo crítico.

---

## 4. Requisitos para DEXs de Perpetuos (Hyperliquid, dYdX Chain)

### ☐ 4.1. Registro y Delegación de Llaves (Hyperliquid API Wallet)
*   **Cuenta Principal de L1**: Tener una cuenta activa en Hyperliquid L1 con fondos depositados en USDC.
*   **Delegación de Llave de Trading (Agent Wallet)**: 
    *   Generar una clave privada secundaria (billetera agente).
    *   Registrar esta clave en Hyperliquid como tu "agente de trading autorizado".
    *   Configurar únicamente esta clave de agente en el `.env` de Helena. Esto permite al bot colocar y cancelar órdenes, pero **no permite retirar fondos** de la cuenta de Hyperliquid principal en caso de hackeo o compromiso de claves.

---

## 5. Matriz de Variables de Entorno a Configurar por el Usuario

Al integrar un nuevo módulo, el usuario deberá añadir las siguientes claves al archivo `.env` según corresponda:

```env
# === CEX INTEGRACIÓN ===
BINANCE_API_KEY=tu_api_key_aqui
BINANCE_API_SECRET=tu_api_secret_aqui
BINANCE_RESTRICCION_IP=true

# === EVM INTEGRACIÓN ===
EVM_PRIVATE_KEY=0x_tu_llave_privada_aqui
EVM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/tu_api_key

# === SOLANA INTEGRACIÓN ===
SOLANA_PRIVATE_KEY=[12,34,56,...64_bytes_del_keypair]
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# === HYPERLIQUID INTEGRACIÓN ===
HYPERLIQUID_AGENT_PRIVATE_KEY=tu_llave_privada_del_agente_aqui
HYPERLIQUID_USE_TESTNET=false
```
