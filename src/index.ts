import { Client } from 'xrpl';
import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLStrategyManager } from './strategyManager.js';
import { XRPLDashboard } from './dashboard.js';
import { XRPLTrustlineManager } from './trustlineManager.js';
import { db } from './db.js';

async function main() {
  console.log('Iniciando bot de trading XRPL...');

  // 1. Inicializar y Arrancar Dashboard Web
  const dashboard = new XRPLDashboard();
  dashboard.start();
  
  // 2. Inicializar cliente global
  const client = new Client(config.xrplWsUrl);
  console.log(`Conectando al nodo XRPL en: ${config.xrplWsUrl}...`);
  await client.connect();
  console.log('Conexión establecida.');

  // 3. Inicializar Wallet Manager
  const walletManager = new XRPLWalletManager(client);
  await walletManager.initializeWallet(config.walletSeed);
  const wallet = walletManager.getWallet();

  if (!wallet) {
    console.error('No se pudo cargar la billetera. Abortando bot.');
    process.exit(1);
  }

  // 4. Consultar balances
  const xrpBalance = await walletManager.getXrpBalance();
  console.log(`Saldo de XRP: ${xrpBalance} XRP`);

  const tokens = await walletManager.getTokensBalances();
  let usdBalance = '0';
  if (tokens.length > 0) {
    console.log('Saldos de otros tokens/IOUs:');
    tokens.forEach(token => {
      console.log(`  - ${token.balance} ${token.currency} (Emisor: ${token.issuer})`);
      if (token.currency === 'USD') {
        usdBalance = token.balance;
      }
    });
  } else {
    console.log('Sin líneas de confianza / balances de tokens activos.');
  }

  // Guardar balance inicial en la base de datos
  db.logBalance(xrpBalance, usdBalance);

  // 5. Configurar Trustline de USD (Fase A)
  const trustlineManager = new XRPLTrustlineManager(client);
  const trustlineOk = await trustlineManager.ensureUsdTrustline(wallet);
  
  if (trustlineOk) {
    db.logTransaction('TRUSTLINE_USD', '', 'tesSUCCESS', { detail: 'Línea de confianza USD Bitstamp configurada' });
    // Si tenemos 0 USD, intentamos hacer un swap inicial de 20 XRP para fondear el lado de compras
    if (parseFloat(usdBalance) === 0) {
      console.log('Saldo de USD en cero. Ejecutando swap inicial para obtener dólares de prueba...');
      await trustlineManager.performInitialSwap(wallet, 20, 1.04);
      
      // Actualizar balances tras el swap
      const updatedXrp = await walletManager.getXrpBalance();
      const updatedTokens = await walletManager.getTokensBalances();
      const updatedUsd = updatedTokens.find(t => t.currency === 'USD')?.balance || '0';
      db.logBalance(updatedXrp, updatedUsd);
    }
  } else {
    console.warn('Advertencia: No se pudo verificar/crear la línea de confianza USD. Las órdenes de compra fallarán.');
  }

  // 6. Instanciar e Iniciar la Estrategia de Market Making (Fase 4)
  let strategyManager: XRPLStrategyManager | null = null;
  strategyManager = new XRPLStrategyManager(client, wallet, dashboard);
  await strategyManager.start();

  // 7. Iniciar Lector de WebSockets
  console.log('\nIniciando módulo de suscripciones WebSocket...');
  const reader = new XRPLWebsocketReader(config.xrplWsUrl);
  try {
    await reader.start();
  } catch (error) {
    console.error('Error al iniciar el lector WebSocket:', error);
  }

  // Manejo de apagado controlado (Graceful shutdown)
  const gracefulShutdown = async () => {
    console.log('\nRecibida señal de apagado. Limpiando recursos...');
    try {
      if (strategyManager) {
        await strategyManager.cancelAllOrders();
      }
      dashboard.stop();
      await reader.stop();
      await client.disconnect();
      console.log('Apagado completado con éxito.');
      process.exit(0);
    } catch (error) {
      console.error('Error durante el apagado:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch((error) => {
  console.error('Error no controlado en la ejecución principal:', error);
  process.exit(1);
});
