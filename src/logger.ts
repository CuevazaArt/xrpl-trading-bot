import fs from 'fs';
import path from 'path';

/**
 * Logger estructurado con colores ANSI para terminal.
 * Diseñado para legibilidad instantánea durante ejecución.
 *
 * Niveles: DEBUG, INFO, WARN, ERROR
 * Sin dependencias externas.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// ═══════════════════════════════════════════════════════════════
// ANSI COLOR PALETTE
// ═══════════════════════════════════════════════════════════════

const C = {
  reset:     '\x1b[0m',
  dim:       '\x1b[2m',
  bold:      '\x1b[1m',
  italic:    '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground
  black:     '\x1b[30m',
  red:       '\x1b[31m',
  green:     '\x1b[32m',
  yellow:    '\x1b[33m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  cyan:      '\x1b[36m',
  white:     '\x1b[37m',

  // Bright foreground
  bRed:      '\x1b[91m',
  bGreen:    '\x1b[92m',
  bYellow:   '\x1b[93m',
  bBlue:     '\x1b[94m',
  bMagenta:  '\x1b[95m',
  bCyan:     '\x1b[96m',
  bWhite:    '\x1b[97m',

  // Background
  bgRed:     '\x1b[41m',
  bgGreen:   '\x1b[42m',
  bgYellow:  '\x1b[43m',
  bgBlue:    '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan:    '\x1b[46m',
  bgWhite:   '\x1b[47m',
  bgBlack:   '\x1b[40m',
};

// Level styling
const LEVEL_STYLE: Record<LogLevel, { label: string; color: string; badge: string }> = {
  [LogLevel.DEBUG]: { label: 'DBG', color: C.dim + C.cyan,     badge: `${C.dim}${C.cyan}DBG${C.reset}` },
  [LogLevel.INFO]:  { label: 'INF', color: C.bGreen,           badge: `${C.bGreen}INF${C.reset}` },
  [LogLevel.WARN]:  { label: 'WRN', color: C.bold + C.bYellow, badge: `${C.bold}${C.bgYellow}${C.black} WRN ${C.reset}` },
  [LogLevel.ERROR]: { label: 'ERR', color: C.bold + C.bRed,    badge: `${C.bold}${C.bgRed}${C.bWhite} ERR ${C.reset}` },
};

// Module colors for visual grouping
const MODULE_COLORS = [C.bCyan, C.bMagenta, C.bBlue, C.bYellow, C.bGreen];
const moduleColorMap = new Map<string, string>();
let colorIndex = 0;

function getModuleColor(mod: string): string {
  if (!moduleColorMap.has(mod)) {
    moduleColorMap.set(mod, MODULE_COLORS[colorIndex % MODULE_COLORS.length]);
    colorIndex++;
  }
  return moduleColorMap.get(mod)!;
}

// Short module names for cleaner output
const MODULE_SHORT: Record<string, string> = {
  'StrategyManager': 'SM',
  'XRPLMarketMakerStrategy': 'Helena',
  'OrderManager': 'Orders',
  'PnLTracker': 'P&L',
  'MultiOracle': 'Oracle',
  'WebSocketReader': 'WS',
  'WalletManager': 'Wallet',
  'TrustlineManager': 'Trust',
  'ArbitrageScanner': 'Arb',
  'Main': 'Main',
};

// Log file setup — async writes + rotation
const logDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFilePath = path.join(logDir, 'app_raw.log');

// Rotation config
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per file
const MAX_ROTATED_FILES = 3;
let logSizeEstimate = 0;
let rotationInProgress = false;

// Initialize size estimate
try {
  if (fs.existsSync(logFilePath)) {
    logSizeEstimate = fs.statSync(logFilePath).size;
  }
} catch { logSizeEstimate = 0; }

/**
 * Rota el archivo de log cuando supera MAX_LOG_SIZE_BYTES.
 * app_raw.log → app_raw.log.1, .log.1 → .log.2, .log.2 → .log.3, .log.3 se elimina.
 */
function rotateLogFile(): void {
  if (rotationInProgress) return;
  rotationInProgress = true;

  try {
    // Eliminar el más viejo
    const oldest = `${logFilePath}.${MAX_ROTATED_FILES}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    // Rotar hacia arriba: .2 → .3, .1 → .2
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${logFilePath}.${i}`;
      const to = `${logFilePath}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }

    // Mover actual a .1
    if (fs.existsSync(logFilePath)) {
      fs.renameSync(logFilePath, `${logFilePath}.1`);
    }

    logSizeEstimate = 0;
  } catch {
    // Silenciar errores de rotación — no son críticos
  } finally {
    rotationInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════

export function printBanner(): void {
  const lines = [
    '',
    `${C.bCyan}${C.bold}  ╔══════════════════════════════════════════╗${C.reset}`,
    `${C.bCyan}${C.bold}  ║${C.reset}  ${C.bMagenta}${C.bold}HELENA${C.reset} ${C.dim}× Kyoto :: Sashimi${C.reset}            ${C.bCyan}${C.bold}║${C.reset}`,
    `${C.bCyan}${C.bold}  ║${C.reset}  ${C.dim}Market Making + IOC Arb • XRPL DEX${C.reset}    ${C.bCyan}${C.bold}║${C.reset}`,
    `${C.bCyan}${C.bold}  ╚══════════════════════════════════════════╝${C.reset}`,
    '',
  ];
  lines.forEach(l => console.log(l));
}

// ═══════════════════════════════════════════════════════════════
// STATUS CARD (replaces per-tick spam)
// ═══════════════════════════════════════════════════════════════

export interface StatusCardData {
  tick: number;
  ledger: number;
  mode: string;
  modeWindow: string;
  price: number;
  bid: number;
  ask: number;
  spread: string;
  buyOrder: string;
  sellOrder: string;
  fills: number;
  roundtrips: number;
  pnl: number;
  fees: number;
  feeLimit: number;
  uptime: string;
  paused: boolean;
  pauseReason?: string;
}

export function printStatusCard(d: StatusCardData): void {
  const pnlColor = d.pnl >= 0 ? C.bGreen : C.bRed;
  const pnlSign = d.pnl >= 0 ? '+' : '';
  const feePercent = ((d.fees / d.feeLimit) * 100).toFixed(0);
  const feeBar = renderBar(d.fees / d.feeLimit, 20);
  const statusIcon = d.paused ? `${C.bold}${C.bRed}PAUSED${C.reset}` : `${C.bold}${C.bGreen}ACTIVE${C.reset}`;

  const lines = [
    `${C.dim}─────────────────────────────────────────────────────${C.reset}`,
    `  ${C.bold}${C.bWhite}#${d.tick}${C.reset} ${C.dim}Ledger${C.reset} ${C.bCyan}${d.ledger}${C.reset}  ${C.dim}|${C.reset}  ${d.mode}  ${C.dim}|${C.reset}  ${statusIcon}  ${C.dim}|${C.reset}  ${C.dim}Up:${C.reset} ${d.uptime}`,
    `  ${C.dim}Price${C.reset} ${C.bold}${C.bWhite}$${d.price.toFixed(4)}${C.reset}  ${C.dim}Bid${C.reset} ${C.bGreen}${d.bid.toFixed(4)}${C.reset}  ${C.dim}Ask${C.reset} ${C.bRed}${d.ask.toFixed(4)}${C.reset}  ${C.dim}Spread${C.reset} ${C.bYellow}${d.spread}${C.reset}`,
    `  ${C.dim}Buy${C.reset} ${d.buyOrder}  ${C.dim}Sell${C.reset} ${d.sellOrder}`,
    `  ${C.dim}Fills${C.reset} ${C.bWhite}${d.fills}${C.reset}  ${C.dim}RTs${C.reset} ${C.bWhite}${d.roundtrips}${C.reset}  ${C.dim}P&L${C.reset} ${pnlColor}${C.bold}${pnlSign}$${d.pnl.toFixed(4)}${C.reset}  ${C.dim}Fees${C.reset} ${feeBar} ${C.dim}${d.fees}/${d.feeLimit}d (${feePercent}%)${C.reset}`,
  ];

  if (d.paused && d.pauseReason) {
    lines.push(`  ${C.bold}${C.bgRed}${C.bWhite} ! ${C.reset} ${C.bRed}${d.pauseReason}${C.reset}`);
  }

  lines.forEach(l => console.log(l));
}

function renderBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const barColor = clamped > 0.8 ? C.bRed : clamped > 0.5 ? C.bYellow : C.bGreen;
  return `${barColor}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset}`;
}

// ═══════════════════════════════════════════════════════════════
// EVENT HIGHLIGHTS (only for things worth seeing)
// ═══════════════════════════════════════════════════════════════

export function logFill(side: 'BUY' | 'SELL', amount: string, price: number, hash?: string): void {
  const icon = side === 'BUY' ? `${C.bold}${C.bgGreen}${C.black} BUY ${C.reset}` : `${C.bold}${C.bgRed}${C.bWhite} SELL ${C.reset}`;
  const shortHash = hash ? `${C.dim}${hash.slice(0, 8)}...${C.reset}` : '';
  console.log(`  ${icon} ${C.bold}${C.bWhite}${amount} XRP${C.reset} ${C.dim}@${C.reset} ${C.bYellow}$${price.toFixed(4)}${C.reset} ${shortHash}`);
}

export function logRoundtrip(num: number, pnl: number, pct: number): void {
  const icon = pnl >= 0
    ? `${C.bold}${C.bgGreen}${C.black} RT#${num} ${C.reset}`
    : `${C.bold}${C.bgRed}${C.bWhite} RT#${num} ${C.reset}`;
  const pnlColor = pnl >= 0 ? C.bGreen : C.bRed;
  const sign = pnl >= 0 ? '+' : '';
  console.log(`  ${icon} ${pnlColor}${C.bold}${sign}$${pnl.toFixed(4)}${C.reset} ${C.dim}(${sign}${pct.toFixed(2)}%)${C.reset}`);
}

export function logModeChange(from: string, to: string, rotation: number, window: number): void {
  console.log(`  ${C.bold}${C.bgBlue}${C.bWhite} MODE ${C.reset} ${C.dim}${from}${C.reset} ${C.bWhite}->${C.reset} ${C.bold}${to}${C.reset} ${C.dim}(#${rotation}, ${window} ledgers)${C.reset}`);
}

export function logIOCResult(side: string, edge: string, result: 'HIT' | 'MISS' | 'SKIP', detail?: string): void {
  const badge = result === 'HIT'
    ? `${C.bold}${C.bgGreen}${C.black} IOC:HIT ${C.reset}`
    : result === 'MISS'
    ? `${C.bold}${C.bgYellow}${C.black} IOC:MISS ${C.reset}`
    : `${C.dim}IOC:SKIP${C.reset}`;
  console.log(`  ${badge} ${C.bWhite}${side}${C.reset} ${C.dim}edge:${C.reset}${C.bYellow}${edge}${C.reset} ${detail ? C.dim + detail + C.reset : ''}`);
}

export function logAlert(message: string): void {
  console.log(`  ${C.bold}${C.bgRed}${C.bWhite} !! ${C.reset} ${C.bRed}${C.bold}${message}${C.reset}`);
}

export function logSuccess(message: string): void {
  console.log(`  ${C.bold}${C.bgGreen}${C.black} OK ${C.reset} ${C.bGreen}${message}${C.reset}`);
}

// ═══════════════════════════════════════════════════════════════
// CORE LOGGER CLASS
// ═══════════════════════════════════════════════════════════════

class Logger {
  private module: string;
  private shortName: string;
  private moduleColor: string;
  private static globalLevel: LogLevel = LogLevel.INFO;

  constructor(module: string) {
    this.module = module;
    this.shortName = MODULE_SHORT[module] || module.slice(0, 8);
    this.moduleColor = getModuleColor(this.shortName);
  }

  static setLevel(level: LogLevel) {
    Logger.globalLevel = level;
  }

  private log(level: LogLevel, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const label = LEVEL_STYLE[level].label;

    // Always write raw to file (for post-analysis) — async to avoid blocking event loop
    const rawLine = `[${timestamp}] [${label}] [${this.module}] ${message}${data !== undefined ? ' ' + (typeof data === 'object' ? JSON.stringify(data) : data) : ''}\n`;
    const lineBytes = Buffer.byteLength(rawLine, 'utf8');
    logSizeEstimate += lineBytes;

    // Trigger rotation if file exceeds max size
    if (logSizeEstimate > MAX_LOG_SIZE_BYTES) {
      rotateLogFile();
    }

    // Async write — deferred to next event loop iteration to avoid blocking the tick
    setImmediate(() => {
      try {
        fs.appendFileSync(logFilePath, rawLine);
      } catch {
        // Ignore file write failures — best-effort logging
      }
    });

    // Terminal output with colors
    if (level < Logger.globalLevel) return;

    const style = LEVEL_STYLE[level];
    const time = timestamp.slice(11, 19); // HH:MM:SS only
    const prefix = `${C.dim}${time}${C.reset} ${style.badge} ${this.moduleColor}${this.shortName.padEnd(7)}${C.reset}`;

    if (data !== undefined) {
      const dataStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
      console.log(`${prefix} ${style.color}${message}${C.reset} ${C.dim}${dataStr}${C.reset}`);
    } else {
      console.log(`${prefix} ${style.color}${message}${C.reset}`);
    }
  }

  debug(message: string, data?: any) { this.log(LogLevel.DEBUG, message, data); }
  info(message: string, data?: any) { this.log(LogLevel.INFO, message, data); }
  warn(message: string, data?: any) { this.log(LogLevel.WARN, message, data); }
  error(message: string, data?: any) { this.log(LogLevel.ERROR, message, data); }
}

/**
 * Crea una instancia de logger con el nombre del módulo como contexto.
 * Uso: const log = createLogger('StrategyManager');
 */
export function createLogger(module: string): Logger {
  return new Logger(module);
}

export { Logger };
