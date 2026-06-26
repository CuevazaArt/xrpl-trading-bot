import { Client } from 'xrpl';
import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLStrategyManager } from './strategyManager.js';

async function main() {
  console.log('Iniciando bot de trading XRPL...');
  
  // 1. Inicializar cliente global
  const client = new Client(config.xrplWsUrl);
  console.log(`Conectando al nodo XRPL en: ${config.xrplWsUrl}...`);
  await client.connect();
  console.log('Conexión establecida.');

  // 2. Inicializar Wallet Manager
  const walletManager = new XRPLWalletManager(client);
  await walletManager.initializeWallet(config.walletSeed);

  // 3. Consultar balances
  const xrpBalance = await walletManager.getXrpBalance();
  console.log(`Saldo de XRP: ${xrpBalance} XRP`);

  const tokens = await walletManager.getTokensBalances();
  if (tokens.length > 0) {
    console.log('Saldos de otros tokens/IOUs:');
    tokens.forEach(token => {
      console.log(`  - ${token.balance} ${token.currency} (Emisor: ${token.issuer})`);
    });
  } else {
    console.log('Sin líneas de confianza / balances de tokens activos.');
  }

  // 4. Instanciar e Iniciar la Estrategia de Market Making
  const wallet = walletManager.getWallet();
  let strategyManager: XRPLStrategyManager | null = null;
  
  if (wallet) {
    strategyManager = new XRPLStrategyManager(client, wallet);
    await strategyManager.start();
  } else {
    console.error('No se pudo iniciar la estrategia porque la billetera no está disponible.');
  }

  // 5. Iniciar Lector de WebSockets
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
