import { db } from './db.js';
import { BinanceSpotClient } from './cexAdapters/binanceSpotClient.js';
import { BinanceAgarthaStrategy, BinanceAgarthaConfig } from './strategies/agartha/binanceAgartha.js';
import { createLogger } from './logger.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Cargar variables de entorno
dotenv.config();

const log = createLogger('AgarthaRunner');

async function main() {
  log.info('=====================================================================');
  log.info('🏛️ INICIANDO INSTANCIA AISLADA DE AGARTHA (BINANCE SPOT) 🏛️');
  log.info('=====================================================================');

  // 1. Inicializar base de datos
  await db.ensureInitialized();

  // 2. Instanciar cliente Spot de Binance
  const client = new BinanceSpotClient();
  if (!client.isConfigured()) {
    log.error('❌ ERROR: BINANCE_API_KEY y/o BINANCE_API_SECRET no están definidas en el archivo .env. Abortando runner.');
    process.exit(1);
  }

  // 3. Leer y parsear configuraciones específicas (intentar cargar catálogo Alpha en vivo primero)
  let symbols: string[] = [];
  const symbolsPath = path.join(process.cwd(), 'data', 'alpha_symbols.json');
  if (fs.existsSync(symbolsPath)) {
    try {
      const content = fs.readFileSync(symbolsPath, 'utf8');
      symbols = JSON.parse(content);
      log.info(`Cargados ${symbols.length} símbolos del catálogo Alpha desde ${symbolsPath}`);
    } catch (err: any) {
      log.warn(`No se pudo leer ${symbolsPath}, usando fallback: ${err.message}`);
    }
  }

  if (symbols.length === 0) {
    const symbolsCsv = process.env.AGARTHA_BINANCE_SYMBOLS || 'FARM,POND,BOB,TA';
    symbols = symbolsCsv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  if (symbols.length === 0) {
    log.error('❌ ERROR: La lista de símbolos de trabajo está vacía. Abortando.');
    process.exit(1);
  }

  const config: BinanceAgarthaConfig = {
    symbols,
    notionalUsdt: parseFloat(process.env.AGARTHA_BINANCE_NOTIONAL || '10.0'),
    trailingEntryPct: parseFloat(process.env.AGARTHA_TRAILING_ENTRY_PCT || '2.0'),
    trailingExitPct: parseFloat(process.env.AGARTHA_TRAILING_EXIT_PCT || '3.0'),
    activationProfitPct: parseFloat(process.env.AGARTHA_ACTIVATION_PROFIT_PCT || '10.0'),
    maxHoldingMinutes: parseInt(process.env.AGARTHA_MAX_HOLDING_MINUTES || '60', 10),
    maxConcurrentPositions: parseInt(process.env.AGARTHA_MAX_CONCURRENT_POSITIONS || '20', 10)
  };

  log.info(`Configuración cargada:`);
  log.info(`  - Símbolos a operar: ${config.symbols.join(', ')}`);
  log.info(`  - Nocional por posición: ${config.notionalUsdt} USDT`);
  log.info(`  - Máximo de posiciones concurrentes: ${config.maxConcurrentPositions}`);
  log.info(`  - Trailing Entry: ${config.trailingEntryPct}% (Rebote desde mínimos)`);
  log.info(`  - Trailing Exit: ${config.trailingExitPct}% (Caída desde máximos)`);
  log.info(`  - Activación Trailing: ${config.activationProfitPct}% (Ganancia para activar rastreo)`);
  log.info(`  - Time Stop: ${config.maxHoldingMinutes} minutos`);

  // 4. Instanciar e inicializar estrategia
  const strategy = new BinanceAgarthaStrategy(client, config);
  try {
    await strategy.init();
    log.info('✅ Estrategia Agartha Binance inicializada correctamente.');
  } catch (err: any) {
    log.error('❌ Error fatal inicializando la estrategia:', err.message || err);
    process.exit(1);
  }

  // 5. Ciclo principal de ejecución
  let keepRunning = true;
  const tickIntervalMs = parseInt(process.env.AGARTHA_TICK_INTERVAL_MS || '10000', 10);
  log.info(`Iniciando tick loop. Intervalo: ${tickIntervalMs / 1000}s`);

  // Graceful shutdown handlers
  const shutdown = async () => {
    log.info('Recibida señal de apagado. Deteniendo runner de Agartha...');
    keepRunning = false;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (keepRunning) {
    const tickStart = Date.now();
    try {
      // Ejecutar tick de estrategia con timeout de seguridad (60s)
      await Promise.race([
        strategy.tick(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de ejecución de tick (60s)')), 60000)
        )
      ]);
    } catch (tickErr: any) {
      log.error(`⚠️ Error no controlado durante el tick:`, tickErr.message || tickErr);
    }

    const elapsed = Date.now() - tickStart;
    const remainingDelay = Math.max(100, tickIntervalMs - elapsed);
    
    if (keepRunning) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }
  }

  log.info('Runner de Agartha Binance apagado con éxito. Estado persistido.');
  process.exit(0);
}

main().catch(err => {
  log.error('Error no controlado en la función principal del runner:', err);
  process.exit(1);
});
