import { createLogger, Logger, LogLevel } from './logger.js';
import { isMainThread, workerData } from 'worker_threads';

const log = createLogger('CLI');

// =====================================================================
// CLI FLAGS — Parser de argumentos de línea de comando
// =====================================================================

/**
 * Flags disponibles para controlar features del bot desde la CLI.
 * Tienen prioridad sobre las variables de entorno cuando hay conflicto.
 * 
 * Uso:
 *   npx tsx src/index.ts --paper-trading --cli-ui --sim-balance=1000
 *   npm run dev -- --paper-trading --telegram --no-dashboard
 */
export interface CLIFlags {
  /** Activa modo paper trading (simula trades sin ejecutar reales) */
  paperTrading: boolean;
  /** Capital simulado inicial en USDT (default: 1000) */
  simBalance: number;
  /** Activa notificaciones Telegram */
  telegram: boolean;
  /** Intervalo de health reports por Telegram en segundos (default: 300) */
  telegramInterval: number;
  /** Desactiva el dashboard web HTTP */
  noDashboard: boolean;
  /** Activa la interface CLI en terminal (TUI) */
  cliUi: boolean;
  /** Fuerza log level a DEBUG */
  verbose: boolean;
  /** Conecta, muestra config y sale sin ejecutar */
  dryRun: boolean;
  /** Omite el swap automático inicial de XRP a USD */
  skipSwap: boolean;
  /** Define un balance USD manual inicial (ej. para simulación/pruebas) */
  manualUsd: number | null;
}

/**
 * Parsea process.argv sin dependencias externas.
 * 
 * Soporta formatos:
 * - Boolean flags: --paper-trading, --no-dashboard
 * - Value flags:   --sim-balance=1000, --telegram-interval=60
 */
export function parseFlags(argv: string[] = process.argv.slice(2)): CLIFlags {
  const flags: CLIFlags = {
    paperTrading: false,
    simBalance: 1000,
    telegram: false,
    telegramInterval: 300,
    noDashboard: false,
    cliUi: false,
    verbose: false,
    dryRun: false,
    skipSwap: false,
    manualUsd: null,
  };

  if (!isMainThread && workerData) {
    if (workerData.PAPER_TRADING === 'true') flags.paperTrading = true;
    if (workerData.SKIP_SWAP === 'true') flags.skipSwap = true;
    if (workerData.NO_DASHBOARD === 'true') flags.noDashboard = true;
    if (workerData.SIM_BALANCE) flags.simBalance = parseFloat(workerData.SIM_BALANCE) || 1000;
    if (workerData.MANUAL_USD) flags.manualUsd = parseFloat(workerData.MANUAL_USD) || 0;
    return flags;
  }

  for (const arg of argv) {
    const [key, value] = arg.split('=');

    switch (key) {
      case '--paper-trading':
      case '--paper':
        flags.paperTrading = true;
        break;

      case '--sim-balance':
        flags.simBalance = parseFloat(value) || 1000;
        break;

      case '--telegram':
        flags.telegram = true;
        break;

      case '--telegram-interval':
        flags.telegramInterval = parseInt(value, 10) || 300;
        break;

      case '--no-dashboard':
        flags.noDashboard = true;
        break;

      case '--cli-ui':
      case '--cli':
        flags.cliUi = true;
        break;

      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;

      case '--dry-run':
        flags.dryRun = true;
        break;

      case '--skip-swap':
        flags.skipSwap = true;
        break;

      case '--manual-usd':
        flags.manualUsd = parseFloat(value) || 0;
        break;

      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;

      default:
        if (arg.startsWith('--')) {
          log.warn(`Flag desconocida: ${arg}`);
        }
        break;
    }
  }

  // Verbose override
  if (flags.verbose) {
    Logger.setLevel(LogLevel.DEBUG);
  }

  return flags;
}

/**
 * Muestra resumen formateado de las flags activas.
 */
export function printFlagsSummary(flags: CLIFlags): void {
  const active: string[] = [];
  if (flags.paperTrading) active.push(`📝 Paper Trading ($${flags.simBalance} USDT)`);
  if (flags.telegram) active.push(`📱 Telegram (cada ${flags.telegramInterval}s)`);
  if (flags.noDashboard) active.push('🚫 Dashboard Web OFF');
  if (flags.cliUi) active.push('🖥️  CLI Dashboard ON');
  if (flags.verbose) active.push('🔍 Verbose (DEBUG)');
  if (flags.dryRun) active.push('🧪 Dry Run');
  if (flags.skipSwap) active.push('⏭️  Saltar Swap Inicial');
  if (flags.manualUsd !== null) active.push(`💵 Saldo USD manual: $${flags.manualUsd}`);

  if (active.length === 0) {
    log.info('CLI Flags: ninguna flag activa (modo por defecto)');
  } else {
    log.info(`CLI Flags activas:`);
    active.forEach(f => log.info(`  ${f}`));
  }
}

/**
 * Genera el texto de ayuda para --help.
 */
function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🤖 PECUNATOR — XRPL Trading Bot                        ║
╚══════════════════════════════════════════════════════════╝

Uso: npx tsx src/index.ts [flags]

Flags disponibles:
  --paper-trading       Modo simulado (no ejecuta trades reales)
  --sim-balance=N       Capital simulado inicial en USDT (default: 1000)
  --telegram            Activa notificaciones Telegram
  --telegram-interval=N Intervalo de health reports en segundos (default: 300)
  --no-dashboard        Desactiva el dashboard web HTTP
  --cli-ui              Activa la interface CLI en terminal
  --verbose, -v         Fuerza log level a DEBUG
  --dry-run             Muestra config y sale sin ejecutar
  --skip-swap           Omite el swap automático inicial de XRP a USD
  --manual-usd=N        Define un balance USD manual inicial
  --help, -h            Muestra esta ayuda

Ejemplos:
  npx tsx src/index.ts --paper-trading --cli-ui
  npx tsx src/index.ts --telegram --telegram-interval=60
  npx tsx src/index.ts --dry-run --paper-trading
  npm run dev -- --paper-trading --sim-balance=500 --verbose
`);
}

// Singleton global — parseado una sola vez al importar
export const flags = parseFlags();
