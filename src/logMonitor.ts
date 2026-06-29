import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { JSONDatabase } from './db.js';

const log = createLogger('LogMonitor');

export class LogMonitor {
  private logPath: string;
  private db: JSONDatabase;
  private lastOffset = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private active = false;

  // Mapa para deduplicación temporal de errores idénticos (evita spam de DB)
  private lastSeenErrors = new Map<string, number>();
  private DEDUPLICATE_WINDOW_MS = 10000; // 10 segundos

  constructor(db: JSONDatabase, logFilePath?: string) {
    this.db = db;
    const strategy = process.env.STRATEGY || 'unknown';
    const issuer = process.env.USD_ISSUER || 'default';
    const isTest = process.env.NODE_ENV === 'test';
    const defaultLogPath = isTest
      ? path.join(process.cwd(), 'data', 'app_raw.log')
      : path.join(process.cwd(), 'data', `app_raw_${strategy}_${issuer}.log`);
    this.logPath = logFilePath || defaultLogPath;
  }

  /**
   * Inicia el monitoreo perpetuo de logs.
   */
  start(intervalMs = 2000): void {
    if (this.active) return;
    this.active = true;

    // Inicializar offset al tamaño actual al arrancar (para monitorear a partir del arranque)
    try {
      if (fs.existsSync(this.logPath)) {
        this.lastOffset = fs.statSync(this.logPath).size;
      }
    } catch {
      this.lastOffset = 0;
    }

    log.info(`Vigilante de logs iniciado. Escuchando cambios en: ${this.logPath}`);
    this.intervalId = setInterval(() => this.pollLogFile(), intervalMs);
  }

  /**
   * Detiene el monitor.
   */
  stop(): void {
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    log.info('Vigilante de logs detenido.');
  }

  /**
   * Lee las líneas nuevas añadidas al archivo desde el último offset.
   */
  private pollLogFile(): void {
    try {
      if (!fs.existsSync(this.logPath)) {
        this.lastOffset = 0;
        return;
      }

      const stats = fs.statSync(this.logPath);
      const currentSize = stats.size;

      // Si el archivo fue rotado o truncado (su tamaño es menor que nuestro último offset)
      if (currentSize < this.lastOffset) {
        this.lastOffset = 0;
      }

      if (currentSize === this.lastOffset) {
        return; // Sin cambios
      }

      // Leer los nuevos bytes
      const readLength = currentSize - this.lastOffset;
      const buffer = Buffer.alloc(readLength);
      const fd = fs.openSync(this.logPath, 'r');
      
      try {
        fs.readSync(fd, buffer, 0, readLength, this.lastOffset);
      } finally {
        fs.closeSync(fd);
      }

      this.lastOffset = currentSize;

      const chunk = buffer.toString('utf8');
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          this.processLogLine(line);
        }
      }
    } catch (err: any) {
      log.error('Error durante la lectura del archivo de logs:', err.message || err);
    }
  }

  /**
   * Analiza una línea de log y registra anomalías de forma depurada.
   */
  private processLogLine(line: string): void {
    // 1. Limpiar colores ANSI
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();

    // 2. Comprobar niveles de log de interés: [ERR] y [WRN]
    const errorMatch = cleanLine.match(/\[([A-Z]{3})\]\s+\[([^\]]+)\]\s+(.*)/);
    if (!errorMatch) return;

    const [, level, module, message] = errorMatch;

    if (level === 'ERR' || level === 'WRN') {
      const errorKey = `${level}:${module}:${message}`;
      const now = Date.now();
      const lastSeen = this.lastSeenErrors.get(errorKey) || 0;

      // Aplicar deduplicación
      if (now - lastSeen < this.DEDUPLICATE_WINDOW_MS) {
        return; // Ignorar por ser duplicado reciente
      }

      this.lastSeenErrors.set(errorKey, now);

      // Limpiar caché vieja periódicamente
      if (this.lastSeenErrors.size > 100) {
        for (const [k, time] of this.lastSeenErrors.entries()) {
          if (now - time > this.DEDUPLICATE_WINDOW_MS * 2) {
            this.lastSeenErrors.delete(k);
          }
        }
      }

      // Registrar en la base de datos local
      this.db.logAnomaly(level, message, { module });
      log.warn(`[WATCHDOG LOG] Anomalía detectada y guardada en DB: ${level} en módulo '${module}' -> "${message.slice(0, 80)}"`);
    }
  }
}
