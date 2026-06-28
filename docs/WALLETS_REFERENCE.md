# 📖 Referencia de Billeteras Programáticas y Reservas de Red (Helena Wallet Adapter Pattern)

Este documento sirve como manual de referencia para configurar, operar y asegurar las distintas opciones de billeteras (EOA, MPC, Safe/AA) dentro del ecosistema de **Helena**.

---

## 1. El Patrón Adaptador de Billeteras (`IWalletProviderAdapter`)

Helena abstrae la firma y consulta de balances a través de la interfaz unificada `IWalletProviderAdapter`. Esto permite intercambiar el motor criptográfico en caliente según la necesidad del operador:

```
[Estrategia Helena] ──> [WalletManager] ──> [IWalletProviderAdapter]
                                                    │
                 ┌──────────────────────────────────┼──────────────────────────────────┐
                 ▼                                  ▼                                  ▼
         [eoa] (Firma Local)               [mock] (Simulación)              [safe] (Safe Smart Account)
```

### Proveedores Soportados (`WALLET_PROVIDER` en `.env`):
1.  **`eoa` (Local Software Wallet)**: Utiliza la librería nativa de la cadena (`xrpl.js`, `ethers.js`) y firma las transacciones localmente usando una clave semilla cargada en memoria.
2.  **`mock` (Billetera de Simulación)**: Genera balances ficticios y simula swaps locales. Es ideal para *Paper Trading* sin arriesgar fondos ni requerir conexión a APIs.
3.  **`safe` (Smart Contract Wallet)**: Diseñado para enrutar las ejecuciones a través del API Relayer de Safe en redes L2, utilizando Session Keys.

---

## 2. Parámetros de Configuración (.env)

Configura tu proveedor de firmas agregando las siguientes variables:

```env
# Proveedor activo: eoa | mock | safe
WALLET_PROVIDER=eoa

# Semilla local (solo requerida si WALLET_PROVIDER=eoa)
XRPL_WALLET_SEED=sEdV3qkRMjNjbEHRdS7vUoWw3hA6mZ...
```

---

## ⚠️ 3. PRECAUCIÓN CRÍTICA: Reserva Obligatoria de Activo Nativo (Gas & Fees)

> [!CAUTION]
> **RESERVA MÍNIMA DE ACTIVO NATIVO GARANTIZADA**
> Toda transacción en blockchains descentralizadas consume comisiones de red cobradas en el activo nativo (XRP en XRPL, ETH en Ethereum/Arbitrum/Base, SOL en Solana). 
> 
> Si tu billetera agota el activo nativo, el bot quedará **paralizado de forma indefinida**, lo que puede dejar posiciones de arbitraje abiertas (sin cobertura) y causar pérdidas de capital severas (*Leg-Locks*).

### 3.1. Requisitos de Reserva en el XRP Ledger (XRPL)
En el XRPL, la red aplica una **reserva de cuenta** bloqueada que no se puede gastar:
*   **Reserva Base**: 10 XRP.
*   **Reserva por Objeto (Owner Count)**: 2 XRP por cada oferta abierta, trustline creada o token.
*   *Ejemplo*: Si tienes una trustline de USD y dos ofertas abiertas (compradora y vendedora), tu cuenta bloqueará `10 + (2 × 3) = 16 XRP`.
*   **Buffer de Seguridad Recomendado**: Configura siempre un buffer holgado por encima de la reserva de la red en tu `.env`:
    ```env
    MIN_XRP_RESERVE_BUFFER=15.0  # 15 XRP de colchón para comisiones de red y fluctuaciones de OwnerCount
    ```

### 3.2. Requisitos de Reserva en EVM L2s y Solana
Si extiendes Helena para operar arbitrajes multi-cadena:
*   **Arbitrum / Base (EVM L2s)**: Mantén un mínimo de **0.005 ETH** dedicados exclusivamente al pago de gas de transacciones en caliente.
*   **Solana**: Mantén un mínimo de **0.05 SOL** para cubrir rentas de cuentas asociadas de tokens (ATA) y tarifas de ejecución de transacciones prioritarias.

### 3.3. Mitigación contra Parálisis por Gas:
1.  **Detección Automática**: El `WalletManager` de Helena ejecuta el chequeo `hasEnoughReserve()` antes de cada tick. Si el balance cae por debajo del umbral base + buffer de seguridad, el bot suspende temporalmente las órdenes y envía una alerta crítica de Telegram.
2.  **Uso de Paymasters (Account Abstraction)**: Si configuras `WALLET_PROVIDER=safe` en cadenas compatibles, se recomienda activar el patrocinio de gas (*gas sponsorship*) a través de un Paymaster, permitiendo pagar las comisiones del bot directamente en USDC/USDT sin requerir ETH en la EOA local.
