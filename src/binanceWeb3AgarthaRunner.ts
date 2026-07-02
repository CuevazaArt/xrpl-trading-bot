import { db } from './db.js';
import { BinanceWeb3Client } from './cexAdapters/binanceWeb3Client.js';
import { BinanceWeb3AgarthaStrategy, BinanceWeb3AgarthaConfig } from './strategies/agartha/binanceWeb3Agartha.js';
import { createLogger } from './logger.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Cargar variables de entorno
dotenv.config();

const log = createLogger('Web3AgarthaRunner');

// Configuración por defecto para inicialización si no existe archivo de catálogo DeFi
const DEFAULT_DEFI_CATALOG = {
  chainId: 'solana',
  quoteAssetSymbol: 'USDC',
  quoteAssetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana USDC
  tokens: {
    'COOKIE': 'CKpuyP6gG2U6VfR68Mpg6X6M4U6v8G8D5z8zP4Q8pump' // AI agent token
  }
};

async function main() {
  log.info('=====================================================================');
  log.info('🏛️ INICIANDO INSTANCIA AISLADA DE AGARTHA DEFI (WEB3 COOPERATIVE) 🏛️');
  log.info('=====================================================================');

  // 1. Inicializar base de datos SQLite WAL
  await db.ensureInitialized();

  // 2. Instanciar cliente Web3 de Binance
  const client = new BinanceWeb3Client();
  if (!client.isConfigured()) {
    log.error('❌ ERROR: BINANCE_WEB3_API_KEY y/o BINANCE_WEB3_API_SECRET no están definidas en .env. Abortando runner.');
    process.exit(1);
  }

  // 3. Cargar catálogo de tokens DeFi y redes
  const catalogPath = path.join(process.cwd(), 'data', 'alpha_web3_tokens.json');
  let catalog = DEFAULT_DEFI_CATALOG;

  if (fs.existsSync(catalogPath)) {
    try {
      const content = fs.readFileSync(catalogPath, 'utf8');
      catalog = JSON.parse(content);
      log.info(`Cargado catálogo de tokens DeFi desde ${catalogPath}`);
    } catch (err: any) {
      log.warn(`No se pudo leer ${catalogPath}, usando configuración por defecto: ${err.message}`);
    }
  } else {
    // Escribir el archivo por defecto para que sirva de guía al usuario
    try {
      const dataDir = path.dirname(catalogPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(catalogPath, JSON.stringify(DEFAULT_DEFI_CATALOG, null, 2), 'utf8');
      log.info(`Creado archivo de catálogo DeFi de ejemplo en: ${catalogPath}`);
    } catch (err: any) {
      log.error(`No se pudo crear el archivo de catálogo DeFi de ejemplo: ${err.message}`);
    }
  }

  // Resolver dirección pública de billetera según la red seleccionada
  const isSolana = catalog.chainId === 'solana';
  const walletAddress = isSolana ? process.env.SOLANA_WALLET_ADDRESS : process.env.EVM_WALLET_ADDRESS;
  const privateKey = isSolana ? process.env.SOLANA_PRIVATE_KEY : process.env.EVM_PRIVATE_KEY;

  if (!walletAddress || !privateKey) {
    log.error(`❌ ERROR DE ENTORNO: No se ha configurado la dirección pública o la clave privada para la red "${catalog.chainId}" en el archivo .env.`);
    process.exit(1);
  }

  const symbols = Object.keys(catalog.tokens);
  if (symbols.length === 0) {
    log.error('❌ ERROR: La lista de símbolos de trabajo está vacía en el catálogo DeFi.');
    process.exit(1);
  }

  // 4. Construir objeto de configuración de la estrategia
  const config: BinanceWeb3AgarthaConfig = {
    chainId: catalog.chainId,
    walletAddress: walletAddress.trim(),
    quoteAssetSymbol: catalog.quoteAssetSymbol || 'USDC',
    quoteAssetAddress: catalog.quoteAssetAddress.trim(),
    notionalAmount: parseFloat(process.env.AGARTHA_BINANCE_NOTIONAL || '10.0'),
    trailingEntryPct: parseFloat(process.env.AGARTHA_TRAILING_ENTRY_PCT || '2.0'),
    trailingExitPct: parseFloat(process.env.AGARTHA_TRAILING_EXIT_PCT || '30.0'),
    activationProfitPct: parseFloat(process.env.AGARTHA_ACTIVATION_PROFIT_PCT || '0.0'),
    maxHoldingMinutes: parseInt(process.env.AGARTHA_MAX_HOLDING_MINUTES || '0', 10),
    maxConcurrentPositions: parseInt(process.env.AGARTHA_MAX_CONCURRENT_POSITIONS || '90', 10),
    symbols,
    tokenAddresses: catalog.tokens
  };

  log.info(`Configuración de Agartha DeFi cargada:`);
  log.info(`  - Red (ChainID): ${config.chainId}`);
  log.info(`  - Billetera: ${config.walletAddress}`);
  log.info(`  - Símbolos a operar: [${config.symbols.join(', ')}]`);
  log.info(`  - Nocional por Swap: ${config.notionalAmount} ${config.quoteAssetSymbol}`);
  log.info(`  - Máximo de posiciones concurrentes: ${config.maxConcurrentPositions}`);
  log.info(`  - Trailing Entry: ${config.trailingEntryPct}% (Rebote desde mínimos)`);
  log.info(`  - Trailing Exit: ${config.trailingExitPct}% (Caída desde picos)`);
  log.info(`  - Activación Trailing: ${config.activationProfitPct}% (Ganancia requerida)`);
  log.info(`  - Time Stop: ${config.maxHoldingMinutes === 0 ? 'Deshabilitado (Dejar correr)' : config.maxHoldingMinutes + ' minutos'}`);

  // 5. Instanciar e inicializar estrategia
  const strategy = new BinanceWeb3AgarthaStrategy(client, config);
  try {
    await strategy.init();
    log.info('✅ Estrategia Agartha DeFi inicializada correctamente.');
  } catch (err: any) {
    log.error('❌ Error fatal inicializando la estrategia DeFi:', err.message || err);
    process.exit(1);
  }

  // 6. Ciclo principal de ejecución
  let keepRunning = true;
  const tickIntervalMs = parseInt(process.env.AGARTHA_TICK_INTERVAL_MS || '10000', 10);
  log.info(`Iniciando tick loop DeFi. Intervalo: ${tickIntervalMs / 1000}s`);

  // Graceful shutdown handlers
  const shutdown = async () => {
    log.info('Recibida señal de apagado. Deteniendo runner DeFi de Agartha...');
    keepRunning = false;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (keepRunning) {
    const tickStart = Date.now();
    try {
      // Ejecutar tick con un timeout de seguridad de 60 segundos
      await Promise.race([
        strategy.tick(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: El tick de la estrategia tardó más de 60 segundos.')), 60000)
        )
      ]);
    } catch (err: any) {
      log.error(`❌ Error crítico en el ciclo de ejecución tick: ${err.message || err}`);
    }

    const elapsed = Date.now() - tickStart;
    const sleepTime = Math.max(0, tickIntervalMs - elapsed);
    if (keepRunning) {
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }
  }

  log.info('Runner DeFi de Agartha apagado con éxito.');
  process.exit(0);
}

main().catch(err => {
  log.error('Error fatal no controlado en main():', err.message || err);
  process.exit(1);
});
