import { Client } from 'xrpl';
import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLStrategyManager } from './strategyManager.js';
import { XRPLDashboard } from './dashboard.js';
import { XRPLTrustlineManager } from './trustlineManager.js';
import { db } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('Main');

// =====================================================================
// RECONEXIÓN AUTOMÁTICA CON BACKOFF EXPONENCIAL
// =====================================================================

async function connectWithRetry(client: Client, maxRetries = 10): Promise<void> {
  let attempt = 0;
  const baseDelay = 1000; // 1 segundo
  const maxDelay = 30000; // 30 segundos máximo

  while (attempt < maxRetries) {
    try {
      log.info(`Conectando al nodo XRPL en: ${config.xrplWsUrl}... (intento ${attempt + 1})`);
      await client.connect();
      log.info('Conexión establecida.');
      return;
    } catch (error) {
      attempt++;
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      log.warn(`Conexión fallida (intento ${attempt}/${maxRetries}). Reintentando en ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`No se pudo conectar al nodo XRPL después de ${maxRetries} intentos.`);
}

function setupReconnection(client: Client, onReconnected: () => Promise<void>) {
  client.on('disconnected', async (code) => {
    log.warn(`Conexión WebSocket perdida (código: ${code}). Intentando reconexión...`);
    try {
      await connectWithRetry(client);
      log.info('Reconexión exitosa. Restaurando suscripciones...');
      await onReconnected();
    } catch (error) {
      log.error('Reconexión fallida definitivamente. El bot se detendrá.', error);
      process.exit(1);
    }
  });
}

// =====================================================================
// FLUJO PRINCIPAL
// =====================================================================

async function main() {
  log.info('Iniciando bot de trading XRPL...');

  // 1. Inicializar y Arrancar Dashboard Web
  const dashboard = new XRPLDashboard();
  dashboard.start();
  
  // 2. Inicializar cliente ÚNICO global
  const client = new Client(config.xrplWsUrl);
  await connectWithRetry(client);

  // 3. Inicializar Wallet Manager
  const walletManager = new XRPLWalletManager(client);
  await walletManager.initializeWallet(config.walletSeed);
  const wallet = walletManager.getWallet();

  if (!wallet) {
    log.error('No se pudo cargar la billetera. Abortando bot.');
    process.exit(1);
  }

  // 4. Consultar balances
  const xrpBalance = await walletManager.getXrpBalance();
  log.info(`Saldo de XRP: ${xrpBalance} XRP`);

  const tokens = await walletManager.getTokensBalances();
  let usdBalance = '0';
  if (tokens.length > 0) {
    log.info('Saldos de otros tokens/IOUs:');
    tokens.forEach(token => {
      log.info(`  - ${token.balance} ${token.currency} (Emisor: ${token.issuer})`);
      if (token.currency === 'USD') {
        usdBalance = token.balance;
      }
    });
  } else {
    log.info('Sin líneas de confianza / balances de tokens activos.');
  }

  // Guardar balance inicial en la base de datos
  db.logBalance(xrpBalance, usdBalance);

  // 5. Configurar Trustline de USD
  const trustlineManager = new XRPLTrustlineManager(client);
  const trustlineOk = await trustlineManager.ensureUsdTrustline(wallet);
  
  if (trustlineOk) {
    db.logTransaction('TRUSTLINE_USD', '', 'tesSUCCESS', { detail: 'Línea de confianza USD Bitstamp configurada' });
    // Si tenemos 0 USD, intentamos hacer un swap inicial de 20 XRP para fondear el lado de compras
    if (parseFloat(usdBalance) === 0) {
      log.info('Saldo de USD en cero. Ejecutando swap inicial para obtener dólares de prueba...');
      await trustlineManager.performInitialSwap(wallet, 20, 1.04);
      
      // Actualizar balances tras el swap
      const updatedXrp = await walletManager.getXrpBalance();
      const updatedTokens = await walletManager.getTokensBalances();
      const updatedUsd = updatedTokens.find(t => t.currency === 'USD')?.balance || '0';
      db.logBalance(updatedXrp, updatedUsd);
    }
  } else {
    log.warn('Advertencia: No se pudo verificar/crear la línea de confianza USD. Las órdenes de compra fallarán.');
  }

  // 6. Iniciar WebSocket Reader (usa el mismo client, NO crea nueva conexión)
  const reader = new XRPLWebsocketReader(client);
  reader.setWalletAddress(wallet.address);

  // Función para restaurar suscripciones tras una reconexión
  const restoreSubscriptions = async () => {
    try {
      await reader.start();
      log.info('Suscripciones WebSocket restauradas.');
    } catch (error) {
      log.error('Error al restaurar suscripciones WebSocket:', error);
    }
  };

  // 7. Configurar reconexión automática
  setupReconnection(client, restoreSubscriptions);

  // 8. Arrancar suscripciones por primera vez
  try {
    await reader.start();
  } catch (error) {
    log.error('Error al iniciar el lector WebSocket:', error);
  }

  // 9. Instanciar e Iniciar la Estrategia de Market Making
  const strategyManager = new XRPLStrategyManager(client, wallet, dashboard);
  await strategyManager.start();

  // Manejo de apagado controlado (Graceful shutdown)
  const gracefulShutdown = async () => {
    log.info('Recibida señal de apagado. Limpiando recursos...');
    try {
      await strategyManager.cancelAllOrders();
      dashboard.stop();
      await client.disconnect();
      log.info('Apagado completado con éxito.');
      process.exit(0);
    } catch (error) {
      log.error('Error durante el apagado:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch((error) => {
  log.error('Error no controlado en la ejecución principal:', error);
  process.exit(1);
});
