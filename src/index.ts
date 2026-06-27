import { Client } from 'xrpl';
import readline from 'readline';
import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLStrategyManager } from './strategyManager.js';
import { XRPLDashboard } from './dashboard.js';
import { XRPLTrustlineManager } from './trustlineManager.js';
import { db } from './db.js';
import { createLogger } from './logger.js';
import { flags, printFlagsSummary } from './cliFlags.js';
import { PaperOrderManager } from './paperTrading.js';
import { HealthMonitor } from './healthMonitor.js';
import { TelegramNotifier } from './telegramNotifier.js';
import { CLIDashboard } from './cliDashboard.js';
import { MultiOracle } from './multiOracle.js';

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
  printFlagsSummary(flags);

  // ─── DRY RUN: mostrar config y salir ───
  if (flags.dryRun) {
    log.info('═══ DRY RUN — Configuración actual ═══');
    log.info(`Estrategia: ${config.strategy}`);
    log.info(`XRPL WS: ${config.xrplWsUrl}`);
    log.info(`Paper Trading: ${flags.paperTrading ? `SI ($${flags.simBalance})` : 'NO'}`);
    log.info(`Telegram: ${flags.telegram ? `SI (cada ${flags.telegramInterval}s)` : 'NO'}`);
    log.info(`Dashboard Web: ${flags.noDashboard ? 'NO' : `SI (puerto ${config.dashboardPort})`}`);
    log.info(`CLI UI: ${flags.cliUi ? 'SI' : 'NO'}`);
    log.info('═══ Fin de Dry Run ═══');
    process.exit(0);
  }

  // 1. Dashboard Web (condicional)
  let dashboard: XRPLDashboard | null = null;
  if (!flags.noDashboard) {
    dashboard = new XRPLDashboard();
    dashboard.start();
  } else {
    log.info('Dashboard web desactivado (--no-dashboard)');
  }
  // Crear un dashboard dummy si está desactivado (para no romper las interfaces)
  const dashboardProxy = dashboard || new XRPLDashboard();

  // 2. CLI Dashboard (condicional)
  let cliDash: CLIDashboard | null = null;
  if (flags.cliUi) {
    cliDash = new CLIDashboard();
  }

  // 3. Inicializar cliente XRPL
  const client = new Client(config.xrplWsUrl);
  await connectWithRetry(client);

  // 4. Inicializar Wallet Manager
  const walletManager = new XRPLWalletManager(client);
  await walletManager.initializeWallet(config.walletSeed);
  const wallet = walletManager.getWallet();

  if (!wallet) {
    log.error('No se pudo cargar la billetera. Abortando bot.');
    process.exit(1);
  }

  // 5. Consultar balances
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
  db.logBalance(xrpBalance, usdBalance);

  // 6. Configurar Trustline de USD
  const trustlineManager = new XRPLTrustlineManager(client);
  const trustlineOk = await trustlineManager.ensureUsdTrustline(wallet);
  
  if (trustlineOk) {
    db.logTransaction('TRUSTLINE_USD', '', 'tesSUCCESS', { detail: 'Línea de confianza USD Bitstamp configurada' });
    if (parseFloat(usdBalance) === 0) {
      let choice = '';
      
      // Determinar la acción a tomar según las flags CLI o la interactividad
      if (!flags.skipSwap && flags.manualUsd === null) {
        if (process.stdin.isTTY) {
          log.info('=====================================================================');
          log.info('⚠️  El saldo de USD en tu billetera XRPL es $0.');
          log.info('Selecciona una opción para fondear tu balance de USD:');
          log.info('  [1] Realizar swap automático (Vender 20 XRP por USD en el DEX)');
          log.info('  [2] Ingresar saldo USD de forma manual (virtual/simulado para Paper Trading)');
          log.info('  [3] Omitir swap y continuar con saldo cero');
          log.info('=====================================================================');
          
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const ans = await new Promise<string>(resolve => {
            const timeout = setTimeout(() => {
              rl.close();
              log.info('\n[TIMEOUT] Se seleccionó la Opción [1] (Swap automático) por defecto después de 5 segundos.');
              resolve('1');
            }, 5000);

            rl.question('Elige una opción [1-3] (default: 1, auto-ejecuta en 5s): ', answer => {
              clearTimeout(timeout);
              rl.close();
              resolve(answer.trim());
            });
          });

          if (ans === '2') choice = 'manual';
          else if (ans === '3' || ans === 'skip') choice = 'skip';
          else choice = 'swap'; // Opción 1 o Enter vacío es swap por defecto
        } else {
          // Si no es terminal interactiva, por seguridad se omite el swap automático
          choice = 'skip';
        }
      } else if (flags.skipSwap) {
        choice = 'skip';
      } else if (flags.manualUsd !== null) {
        choice = 'manual';
      }

      if (choice === 'swap') {
        log.info('Saldo de USD en cero. Ejecutando swap inicial para obtener dólares de prueba...');
        await trustlineManager.performInitialSwap(wallet, 20, 1.04);
        const updatedXrp = await walletManager.getXrpBalance();
        const updatedTokens = await walletManager.getTokensBalances();
        const updatedUsd = updatedTokens.find(t => t.currency === 'USD')?.balance || '0';
        db.logBalance(updatedXrp, updatedUsd);
      } else if (choice === 'manual') {
        let manualBalance = flags.manualUsd;
        if (manualBalance === null) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const ans = await new Promise<string>(resolve => {
            rl.question('Ingresa la cantidad de USD a simular (ej. 100): ', answer => {
              rl.close();
              resolve(answer.trim());
            });
          });
          manualBalance = parseFloat(ans) || 100;
        }
        log.info(`Estableciendo balance USD simulado a: $${manualBalance} USD`);
        usdBalance = manualBalance.toString();
        db.logBalance(xrpBalance, usdBalance);
      } else {
        log.info('Continuando con balance USD en cero (sin swap).');
      }
    }
  } else {
    log.warn('Advertencia: No se pudo verificar/crear la línea de confianza USD. Las órdenes de compra fallarán.');
  }

  // 7. WebSocket Reader
  const reader = new XRPLWebsocketReader(client);
  reader.setWalletAddress(wallet.address);
  try {
    await reader.start();
  } catch (error) {
    log.error('Error al iniciar el lector WebSocket:', error);
  }

  // 8. Paper Trading (condicional) — inyectar PaperOrderManager
  let paperOrderManager: PaperOrderManager | null = null;
  if (flags.paperTrading) {
    paperOrderManager = new PaperOrderManager(client, flags.simBalance, config.strategy);
    log.info(`📝 Modo Paper Trading activado. Capital simulado: $${flags.simBalance} USDT`);
  }

  // 9. Singleton: MultiOracle compartido (evitar instancias duplicadas)
  const sharedOracle = new MultiOracle();

  // 10. Strategy Manager (inyectar singletons)
  const strategyManager = new XRPLStrategyManager(
    client, wallet, walletManager, sharedOracle, dashboardProxy, paperOrderManager || undefined
  );

  // Iniciar el CLI Dashboard si está activado
  if (cliDash) {
    cliDash.start();
  }

  await strategyManager.start();

  // 11. Arrancar escáner de arbitraje atómico en el mismo proceso (comparte client y wallet)
  const { startArbitrageScanner } = await import('./arbitrage.js');
  startArbitrageScanner(client, wallet);

  // 12. Health Monitor (condicional)
  let healthMonitor: HealthMonitor | null = null;
  let telegram: TelegramNotifier | null = null;

  if (flags.telegram || flags.cliUi) {
    healthMonitor = new HealthMonitor(client);

    // Inyectar MultiOracle compartido (singleton — no crear otra instancia)
    healthMonitor.setOracle(sharedOracle);

    // Funds fetcher
    healthMonitor.setFundsFetcher(async () => {
      try {
        const xrp = parseFloat(await walletManager.getXrpBalance()) || 0;
        const usdLine = (await walletManager.getTokensBalances()).find(t => t.currency === 'USD');
        const usd = usdLine ? parseFloat(usdLine.balance) : 0;
        const xrpPrice = (await sharedOracle.getConsensusPrice())?.price || 0;
        return {
          dex: { xrp, usd },
          cex: { xrp: 0, usdt: 0 }, // CEX requiere API keys
          totalValueUsdt: (xrp * xrpPrice) + usd,
        };
      } catch {
        return { dex: { xrp: 0, usd: 0 }, cex: { xrp: 0, usdt: 0 }, totalValueUsdt: 0 };
      }
    });

    // Paper trading fetcher
    if (paperOrderManager) {
      healthMonitor.setPaperFetcher(() => {
        const db = paperOrderManager!.getDB();
        const p = db.getPortfolio();
        const m = db.getMetrics();
        return {
          portfolioUsdt: p.totalValueUsdt,
          pnlUsdt: p.pnlUsdt,
          pnlPct: p.pnlPct,
          totalTrades: m.totalTrades,
          winRate: m.winRate,
        };
      });
    }

    // Telegram
    if (flags.telegram) {
      telegram = new TelegramNotifier();
      if (telegram.isConfigured()) {
        healthMonitor.setTelegram(telegram);
        const activeFeatures: string[] = [];
        if (flags.paperTrading) activeFeatures.push('Paper Trading');
        if (flags.cliUi) activeFeatures.push('CLI Dashboard');
        if (!flags.noDashboard) activeFeatures.push('Web Dashboard');
        await telegram.sendStartup(config.strategy, activeFeatures);
      } else {
        log.warn('Telegram solicitado (--telegram) pero TELEGRAM_BOT_TOKEN/CHAT_ID no configurados.');
      }
    }

    // Conectar health monitor al strategy manager para updates por tick
    strategyManager.setHealthMonitor(healthMonitor);

    // Conectar CLI dashboard al health monitor
    if (cliDash) {
      strategyManager.setCliDashboard(cliDash);
    }

    // Iniciar timer periódico
    const interval = flags.telegram ? flags.telegramInterval : config.healthIntervalSeconds;
    healthMonitor.start(interval);
  }

  // Reconexión automática
  const restoreSubscriptions = async () => {
    try {
      await reader.start();
      await strategyManager.resubscribeLedger();
      log.info('Suscripciones WebSocket y ledger stream restaurados.');
    } catch (error) {
      log.error('Error al restaurar suscripciones WebSocket:', error);
    }
  };
  setupReconnection(client, restoreSubscriptions);

  // Graceful shutdown
  const startTime = Date.now();
  const gracefulShutdown = async () => {
    log.info('Recibida señal de apagado. Limpiando recursos...');
    try {
      await strategyManager.cancelAllOrders();
      if (healthMonitor) healthMonitor.stop();
      if (cliDash) cliDash.stop();
      if (dashboard) dashboard.stop();
      if (telegram?.isConfigured()) {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        await telegram.sendShutdown(uptime);
      }
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

// Manejadores globales para evitar caídas del proceso por errores asíncronos imprevistos
process.on('uncaughtException', (error) => {
  log.error('EXCEPCIÓN NO CONTROLADA DETECTADA (uncaughtException):', error);
  // Al ser un bot de trading, dejamos que el proceso siga vivo e intente recuperarse
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('RECHAZO DE PROMESA NO CONTROLADO (unhandledRejection):', {
    promise,
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

