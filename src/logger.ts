import fs from 'fs';
import path from 'path';

/**
 * Logger estructurado ligero para el bot XRPL.
 * Niveles: DEBUG, INFO, WARN, ERROR
 * Sin dependencias externas.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO ',
  [LogLevel.WARN]: 'WARN ',
  [LogLevel.ERROR]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[36m',  // Cyan
  [LogLevel.INFO]: '\x1b[32m',   // Green
  [LogLevel.WARN]: '\x1b[33m',   // Yellow
  [LogLevel.ERROR]: '\x1b[31m',  // Red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const logDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFilePath = path.join(logDir, 'app_raw.log');

class Logger {
  private module: string;
  private static globalLevel: LogLevel = LogLevel.INFO; // INFO por defecto para evitar ruido

  constructor(module: string) {
    this.module = module;
  }

  static setLevel(level: LogLevel) {
    Logger.globalLevel = level;
  }

  private log(level: LogLevel, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const label = LEVEL_LABELS[level];

    // Escribir siempre la copia raw al archivo
    const rawLine = `[${timestamp}] [${label}] [${this.module}] ${message}${data !== undefined ? ' ' + (typeof data === 'object' ? JSON.stringify(data) : data) : ''}\n`;
    try {
      fs.appendFileSync(logFilePath, rawLine);
    } catch {
      // Ignorar fallos de log en archivo
    }

    // Filtrar para salida en terminal
    if (level < Logger.globalLevel) return;

    const color = LEVEL_COLORS[level];
    const prefix = `${DIM}${timestamp}${RESET} ${color}[${label}]${RESET} ${DIM}[${this.module}]${RESET}`;

    if (data !== undefined) {
      console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
    } else {
      console.log(`${prefix} ${message}`);
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
