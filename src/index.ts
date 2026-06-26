import { Client } from 'xrpl';
import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLOrderManager } from './orderManager.js';

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

  // 4. Instanciar Order Manager y realizar Prueba de Colocación y Cancelación de Orden
  const wallet = walletManager.getWallet();
  if (wallet) {
    const orderManager = new XRPLOrderManager(client);
    console.log('\n--- Iniciando prueba de órdenes (DEX) ---');

    // Colocamos una oferta imposible de emparejar (comprar 1,000,000 USD por 1 gota de XRP) para poder cancelarla
    const dummyUSD = {
      currency: 'USD',
      value: '1000000.0',
      issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'
    };
    const dummyXRP = '1'; // 1 gota de XRP (0.000001 XRP)

    console.log(`Colocando orden límite de compra (comprar 1,000,000 USD por 1 gota de XRP)...`);
    const orderResult = await orderManager.createLimitOrder(wallet, dummyUSD, dummyXRP);

    if (orderResult.success && orderResult.sequence !== undefined) {
      console.log(`Orden límite colocada con secuencia: ${orderResult.sequence}`);
      console.log('Esperando 5 segundos antes de cancelarla...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log(`Cancelando orden con secuencia: ${orderResult.sequence}...`);
      await orderManager.cancelOrder(wallet, orderResult.sequence);
    } else {
      console.error('La prueba de colocación de orden falló.');
    }
    console.log('--- Fin de la prueba de órdenes (DEX) ---\n');
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
