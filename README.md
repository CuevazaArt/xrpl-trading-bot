# 🤖 Helena — Advanced XRPL Trading & Arbitrage Engine

Helena es un motor de trading algorítmico y arbitraje multi-venue de alto rendimiento diseñado para el **XRP Ledger (XRPL)** y exchanges centralizados (CeFi). El bot cuenta con un sistema de auto-sanación perpétuo (*Self-Healing Watchdog*), una capa modular de billeteras programáticas y un bucle interactivo de expansión gradual de venues.

---

## 🚀 Características Clave

*   **Estrategias de Trading Avanzadas**:
    *   **Market Maker (Carousel)**: Rota dinámicamente entre spreads estrechos (`TIGHT`), spreads amplios (`STANDARD`), ejecución de oportunidad (`IOC`), y descanso temporizado (`REST`).
    *   **DCA Algorithms**: Dorothy DCA (Long), Elphaba DCA (Short), Louise DCA (Multi-step), Thusnelda Basket DCA, Masha DCA MTF, y Agartha Moonshot Trailing.
    *   **Arbitraje de 2/3 Patas**: Detección y ejecución en milisegundos de oportunidades entre el DEX de XRPL y CEXs.
*   **Modularidad Absoluta (Plug & Play)**:
    *   **DEX & CEX Adapters**: Lógica comercial desacoplada del protocolo de red (`IDEXAdapter`, `ICEXAdapter`).
    *   **Wallet Providers**: Soporte para firmas EOA en caliente, simulaciones locales (`MockWallet`) y Smart Accounts de Safe (`SafeWalletAdapter` ERC-4337).
*   **Auto-Sanación Perpetua (Watchdog)**:
    *   **Prevención de Zombie**: Resuelve bloqueos silenciosos de hilos.
    *   **Integridad de DB**: Repara automáticamente el archivo de almacenamiento local `db.json` ante corrupciones de escritura.
    *   **RPC Node Failover**: Rota endpoints alternativos ante microcortes o caídas de red.
*   **LogMonitor & Alertas**:
    *   Vigila y procesa en segundo plano el log de salida, eliminando colores ANSI y aplicando deduplicación temporal de 10s para filtrar y registrar anomalías.
*   **Bucle de Expansión Gradual**:
    *   Monitorea 12 horas continuas de estabilidad libre de anomalías. Al finalizar con éxito, Helena emite una tarjeta interactiva en consola detallando el próximo exchange candidato a integrar (Binance, OKX, Safe), con sus requisitos de fondeo y API keys.

---

## 🛠️ Instalación y Arranque Rápido

### Requisitos
*   **Node.js**: v18+ (recomendado v20)
*   **Cuenta XRPL**: Wallet activa con Trustline USD configurada.

### Pasos
1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Configurar el entorno:
   ```bash
   cp .env.example .env
   # Edita el archivo .env con tu seed de XRPL y WS URLs
   ```
3. Compilar el proyecto:
   ```bash
   npm run build
   ```
4. Iniciar en modo Paper Trading (Simulación):
   ```bash
   node dist/index.js --paper-trading --skip-swap
   ```

---

## 🔑 Protocolo de Transición a Real (Mainnet)

Para migrar con seguridad a Mainnet y operar con capital real:

1. **Cifrado de Semilla**:
   Ejecuta `npm run vault:encrypt` e introduce una contraseña robusta. Esto cifrará la frase semilla de tu wallet en `data/vault.json`. Borra la variable `XRPL_WALLET_SEED` del archivo `.env` físico. Al arrancar, Helena solicitará tu contraseña interactiva para descifrar la clave únicamente en memoria RAM.
2. **Fondeo Mínimo Viable (12 Horas de Operación)**:
    *   **Fondo de Comisiones (XRP Nativo)**: **30 XRP** libres en wallet (cubre la reserva de cuenta, reserva de objetos y comisiones del ledger).
    *   **Fondo de Trading (Inventario)**: **100 XRP + $100 USD/USDT** para evitar la parálisis por inventario (*Leg-Lock*).

---

## 🧪 Suite de Pruebas

Para correr las pruebas unitarias y de integración de Vitest (95 tests exitosos):
```bash
npm test
```
