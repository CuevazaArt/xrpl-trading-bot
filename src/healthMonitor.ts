import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Client } from 'xrpl';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { MultiOracle } from './multiOracle.js';
import { TelegramNotifier } from './telegramNotifier.js';
import { flags } from './cliFlags.js';

const log = createLogger('HealthMonitor');

// =====================================================================
// TIPOS
// =====================================================================

export interface HealthSnapshot {
  timestamp: string;
  online: boolean;
  uptimeSeconds: number;
  strategy: string;
  ledgerHeight: number;
  tickCount: number;

  oracle: {
    healthy: boolean;
    activeSources: number;
    totalSources: number;
    xrpPrice: number;
    confidence: number;
  };

  funds: {
    dex: { xrp: number; usd: number };
    cex: { xrp: number; usdt: number };
    totalValueUsdt: number;
  };

  paper?: {
    portfolioUsdt: number;
    pnlUsdt: number;
    pnlPct: number;
    totalTrades: number;
    winRate: number;
  };

  features: {
    paperTrading: boolean;
    telegram: boolean;
    cliUi: boolean;
    dashboard: boolean;
  };

  warnings: string[];
}

// =====================================================================
// HEALTH MONITOR
// =====================================================================

/**
 * Monitor periódico de salud del bot.
 * 
 * Recolecta estado de todos los subsistemas cada N segundos:
 * - Conexión XRPL
 * - MultiOracle
 * - Fondos DEX + CEX
 * - Paper trading (si activo)
 * 
 * Persiste en data/health_log.jsonl (append-only, 1 línea por snapshot).
 * Opcionalmente notifica vía Telegram.
 */
export class HealthMonitor {
  private client: Client;
  private startTime: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private logPath: string;
  private logLineCount: number = 0;
  private readonly maxLogLines: number = 1000;

  // Referencias externas (se inyectan después)
  private oracle: MultiOracle | null = null;
  private telegram: TelegramNotifier | null = null;
  private currentLedger: number = 0;
  private tickCount: number = 0;
  private strategyName: string = 'unknown';

  // Callbacks para obtener datos en tiempo real
  private fundsFetcher: (() => Promise<HealthSnapshot['funds']>) | null = null;
  private paperFetcher: (() => HealthSnapshot['paper'] | undefined) | null = null;

  constructor(client: Client) {
    this.client = client;
    this.startTime = Date.now();

    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logPath = path.join(dir, 'health_log.jsonl');

    // Contar líneas existentes
    if (fs.existsSync(this.logPath)) {
      try {
        const content = fs.readFileSync(this.logPath, 'utf8');
        this.logLineCount = content.split('\n').filter(l => l.trim()).length;
      } catch { this.logLineCount = 0; }
    }
  }

  /**
   * Inyecta dependencias opcionales.
   */
  setOracle(oracle: MultiOracle): void { this.oracle = oracle; }
  setTelegram(telegram: TelegramNotifier): void { this.telegram = telegram; }
  setFundsFetcher(fn: () => Promise<HealthSnapshot['funds']>): void { this.fundsFetcher = fn; }
  setPaperFetcher(fn: () => HealthSnapshot['paper'] | undefined): void { this.paperFetcher = fn; }

  /**
   * Actualiza estado del ledger (llamar desde strategyManager en cada tick).
   */
  updateLedgerState(ledger: number, tick: number, strategy: string): void {
    this.currentLedger = ledger;
    this.tickCount = tick;
    this.strategyName = strategy;
  }

  /**
   * Inicia el timer periódico de health checks.
   */
  start(intervalSeconds: number = config.healthIntervalSeconds): void {
    log.info(`Health Monitor iniciado. Intervalo: ${intervalSeconds}s`);

    // Primer check inmediato
    this.collectAndReport().catch(err => log.error('Error en health check:', err));

    this.timer = setInterval(() => {
      this.collectAndReport().catch(err => log.error('Error en health check:', err));
    }, intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Health Monitor detenido.');
    }
  }

  /**
   * Recolecta snapshot de salud, lo persiste y lo notifica.
   */
  async collectAndReport(): Promise<HealthSnapshot> {
    const snapshot = await this.collectSnapshot();

    // Persistir en JSONL
    await this.appendToLog(snapshot);

    // Notificar vía Telegram (si configurado)
    if (this.telegram) {
      try {
        await this.telegram.sendHealthReport(snapshot);
      } catch (err) {
        log.error('Error enviando health report a Telegram:', err);
      }
    }

    return snapshot;
  }

  /**
   * Obtiene el último snapshot sin forzar un nuevo report.
   */
  async getSnapshot(): Promise<HealthSnapshot> {
    return this.collectSnapshot();
  }

  private async collectSnapshot(): Promise<HealthSnapshot> {
    const warnings: string[] = [];

    // Oracle
    let oracleData = { healthy: false, activeSources: 0, totalSources: 4, xrpPrice: 0, confidence: 0 };
    if (this.oracle) {
      const health = this.oracle.getSourceHealth();
      const activeSources = Object.values(health).filter(h => h.healthy).length;
      const consensus = await this.oracle.getConsensusPrice();

      oracleData = {
        healthy: activeSources >= 2,
        activeSources,
        totalSources: Object.keys(health).length,
        xrpPrice: consensus?.price || 0,
        confidence: consensus?.confidence || 0,
      };

      if (!oracleData.healthy) warnings.push('Oráculo degradado');
      if (oracleData.xrpPrice === 0) warnings.push('Sin precio de mercado');
    } else {
      warnings.push('MultiOracle no conectado');
    }

    // Fondos
    let funds: HealthSnapshot['funds'] = {
      dex: { xrp: 0, usd: 0 },
      cex: { xrp: 0, usdt: 0 },
      totalValueUsdt: 0,
    };
    if (this.fundsFetcher) {
      try {
        funds = await this.fundsFetcher();
      } catch {
        warnings.push('Error al consultar fondos');
      }
    }

    // Paper trading
    let paper: HealthSnapshot['paper'] | undefined;
    if (this.paperFetcher) {
      paper = this.paperFetcher();
    }

    // Conexión
    const online = this.client.isConnected();
    if (!online) warnings.push('XRPL desconectado');

    // Features
    const features = {
      paperTrading: flags.paperTrading,
      telegram: flags.telegram,
      cliUi: flags.cliUi,
      dashboard: !flags.noDashboard,
    };

    return {
      timestamp: new Date().toISOString(),
      online,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      strategy: this.strategyName,
      ledgerHeight: this.currentLedger,
      tickCount: this.tickCount,
      oracle: oracleData,
      funds,
      paper,
      features,
      warnings,
    };
  }

  private async appendToLog(snapshot: HealthSnapshot): Promise<void> {
    try {
      const line = JSON.stringify(snapshot) + '\n';
      await fsp.appendFile(this.logPath, line, 'utf8');
      this.logLineCount++;

      // Rotación: si excede maxLogLines, truncar la mitad más antigua
      if (this.logLineCount > this.maxLogLines) {
        await this.rotateLog();
      }
    } catch (error) {
      log.error('Error al escribir health log:', error);
    }
  }

  private async rotateLog(): Promise<void> {
    try {
      const content = await fsp.readFile(this.logPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const kept = lines.slice(Math.floor(lines.length / 2));
      await fsp.writeFile(this.logPath, kept.join('\n') + '\n', 'utf8');
      this.logLineCount = kept.length;
      log.debug(`Health log rotado: ${lines.length} → ${kept.length} líneas`);
    } catch (error) {
      log.error('Error al rotar health log:', error);
    }
  }
}
