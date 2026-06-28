import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Client } from 'xrpl';
import { createLogger } from './logger.js';
import { db } from './db.js';
import { MultiOracle } from './multiOracle.js';
import { TelegramNotifier } from './telegramNotifier.js';
import { config } from './config.js';

const log = createLogger('Watchdog');

// =====================================================================
// TIPOS
// =====================================================================

/** Estado persistido en disco para recuperación tras crash */
export interface CheckpointState {
  timestamp: string;
  sessionId: string;
  lastLedger: number;
  lastTickCount: number;
  lastOraclePrice: number;
  strategyName: string;
  activeOrderSequences: number[];
  gracefulShutdown: boolean;
  watchdogCycleCount: number;
  /** Cuántos ciclos consecutivos sin ticks productivos */
  zombieStreak: number;
}

/** Resultado de una ronda de diagnóstico */
interface DiagnosticResult {
  healthy: boolean;
  checks: {
    dbIntegrity: 'ok' | 'repaired' | 'failed';
    wsConnection: 'ok' | 'disconnected' | 'reconnected';
    oracleAlive: 'ok' | 'stale' | 'dead';
    tickProgress: 'ok' | 'stalled' | 'zombie';
    memoryPressure: 'ok' | 'warning' | 'critical';
    diskUsage: 'ok' | 'warning' | 'critical';
  };
  repairs: string[];
  warnings: string[];
}

// =====================================================================
// SELF-HEALING WATCHDOG
// =====================================================================

/**
 * Rutina integrada de auto-sanación para Helena.
 * 
 * Responsabilidades:
 * 1. **Anti-Zombie**: Detecta periodos de runtime sin actividad productiva y alerta/reinicia.
 * 2. **Integridad de DB**: Valida JSON, repara corrupción, podar datos viejos antes de escritura.
 * 3. **Persistencia de Estado**: Guarda checkpoint periódico a disco, restaura al reiniciar.
 * 4. **Monitoreo de Recursos**: Memoria, disco, conexiones WebSocket.
 * 5. **Comunicación con DB**: Verifica constantemente que la DB local sea accesible y consistente.
 */
export class SelfHealingWatchdog {
  private client: Client;
  private oracle: MultiOracle | null = null;
  private telegram: TelegramNotifier | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Configuración
  private readonly intervalMs: number;
  private readonly dataDir: string;
  private readonly checkpointPath: string;
  private readonly dbPath: string;

  // Estado de seguimiento
  private sessionId: string;
  private cycleCount: number = 0;
  private lastKnownLedger: number = 0;
  private lastKnownTickCount: number = 0;
  private lastOraclePrice: number = 0;
  private strategyName: string = 'unknown';
  private activeOrderSequences: number[] = [];
  private zombieStreak: number = 0;
  private previousTickCount: number = 0;
  private previousLedger: number = 0;

  // Umbrales anti-zombie
  private readonly ZOMBIE_THRESHOLD_CYCLES = 5;      // 5 ciclos sin progreso → zombie alert
  private readonly ZOMBIE_CRITICAL_CYCLES = 10;      // 10 ciclos → solicitar reinicio
  private readonly MEMORY_WARNING_MB = 180;
  private readonly MEMORY_CRITICAL_MB = 350;
  private readonly DISK_WARNING_MB = 80;
  private readonly DISK_CRITICAL_MB = 200;

  constructor(client: Client, intervalSeconds: number = 60) {
    this.client = client;
    this.intervalMs = intervalSeconds * 1000;
    this.dataDir = path.join(process.cwd(), 'data');
    this.checkpointPath = path.join(this.dataDir, 'checkpoint.json');
    this.dbPath = path.join(this.dataDir, 'db.json');
    this.sessionId = this.generateSessionId();

    // Asegurar que el directorio de datos existe
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // =====================================================================
  // INYECCIÓN DE DEPENDENCIAS
  // =====================================================================

  setOracle(oracle: MultiOracle): void { this.oracle = oracle; }
  setTelegram(telegram: TelegramNotifier): void { this.telegram = telegram; }

  /**
   * Actualiza el estado conocido del bot (llamado desde strategyManager en cada tick).
   */
  updateState(ledger: number, tickCount: number, price: number, strategy: string): void {
    this.lastKnownLedger = ledger;
    this.lastKnownTickCount = tickCount;
    this.lastOraclePrice = price;
    this.strategyName = strategy;
  }

  /**
   * Registra las secuencias de órdenes activas (para persistencia tras crash).
   */
  setActiveOrders(sequences: number[]): void {
    this.activeOrderSequences = [...sequences];
  }

  // =====================================================================
  // CICLO DE VIDA
  // =====================================================================

  /**
   * Arranca el watchdog. Primero restaura estado del último checkpoint si existe.
   */
  start(): void {
    log.info(`🛡️ Watchdog arrancado — ciclo cada ${this.intervalMs / 1000}s`);

    // Intentar restaurar estado del último crash
    const restored = this.restoreCheckpoint();
    if (restored) {
      log.info(`♻️ Estado restaurado de sesión anterior: ledger #${restored.lastLedger}, ticks: ${restored.lastTickCount}`);
      if (!restored.gracefulShutdown) {
        log.warn('⚠️ La sesión anterior NO terminó con graceful shutdown. Posible crash detectado.');
        this.notifyCritical('Helena se recuperó de un crash. La sesión anterior no terminó limpiamente.');
      }
    }

    // Guardar checkpoint inicial
    this.saveCheckpoint(false);

    // Timer periódico
    this.timer = setInterval(() => {
      this.runDiagnosticCycle().catch(err => {
        log.error('Error en ciclo de diagnóstico del Watchdog:', err);
      });
    }, this.intervalMs);
  }

  /**
   * Detiene el watchdog y guarda checkpoint final (graceful).
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Guardar checkpoint con flag de shutdown limpio
    this.saveCheckpoint(true);
    log.info('🛡️ Watchdog detenido. Checkpoint guardado (graceful).');
  }

  // =====================================================================
  // CICLO DE DIAGNÓSTICO PRINCIPAL
  // =====================================================================

  /**
   * Ejecuta un ciclo completo de diagnóstico y reparación.
   */
  async runDiagnosticCycle(): Promise<DiagnosticResult> {
    this.cycleCount++;
    const result: DiagnosticResult = {
      healthy: true,
      checks: {
        dbIntegrity: 'ok',
        wsConnection: 'ok',
        oracleAlive: 'ok',
        tickProgress: 'ok',
        memoryPressure: 'ok',
        diskUsage: 'ok',
      },
      repairs: [],
      warnings: [],
    };

    // 1. Verificar integridad de la DB
    result.checks.dbIntegrity = this.checkAndRepairDB(result);

    // 2. Verificar conexión WebSocket
    result.checks.wsConnection = this.checkWebSocket(result);

    // 3. Verificar oráculo
    result.checks.oracleAlive = await this.checkOracle(result);

    // 4. Detectar estado zombie (sin progreso de ticks)
    result.checks.tickProgress = this.checkTickProgress(result);

    // 5. Verificar presión de memoria
    result.checks.memoryPressure = this.checkMemory(result);

    // 6. Verificar uso de disco
    result.checks.diskUsage = this.checkDisk(result);

    // 7. Podar DB antes de guardar si es necesario
    this.pruneDBIfNeeded();

    // 8. Guardar checkpoint periódico
    this.saveCheckpoint(false);

    // Determinar salud general
    const criticalFailures = Object.values(result.checks).filter(c => c === 'failed' || c === 'critical' || c === 'dead').length;
    result.healthy = criticalFailures === 0;

    // Log resumen
    if (!result.healthy) {
      log.error(`🚨 Watchdog ciclo #${this.cycleCount}: ${criticalFailures} fallo(s) crítico(s)`, {
        checks: result.checks,
        repairs: result.repairs,
      });
    } else if (result.repairs.length > 0 || result.warnings.length > 0) {
      log.warn(`🛡️ Watchdog ciclo #${this.cycleCount}: ${result.repairs.length} reparación(es), ${result.warnings.length} advertencia(s)`);
    } else if (this.cycleCount % 10 === 0) {
      // Log cada 10 ciclos si todo está bien (no spamear)
      log.debug(`🛡️ Watchdog ciclo #${this.cycleCount}: Todo OK`);
    }

    // Alertar vía Telegram si hay problemas críticos
    if (!result.healthy && this.telegram?.isConfigured()) {
      const checksStr = Object.entries(result.checks)
        .filter(([, v]) => v !== 'ok')
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      await this.notifyCritical(`Diagnóstico falló: ${checksStr}`);
    }

    // Actualizar tracking para siguiente ciclo
    this.previousTickCount = this.lastKnownTickCount;
    this.previousLedger = this.lastKnownLedger;

    return result;
  }

  // =====================================================================
  // CHECKS INDIVIDUALES
  // =====================================================================

  /**
   * 1. Verifica integridad de db.json — parsea, valida schema, repara si corrupto.
   */
  private checkAndRepairDB(result: DiagnosticResult): 'ok' | 'repaired' | 'failed' {
    try {
      const { healthy, repaired } = db.reloadAndValidate();
      if (repaired) {
        result.repairs.push('db.json reparada/reconstruida en memoria y guardada');
        return 'repaired';
      }
      return healthy ? 'ok' : 'repaired';
    } catch (error) {
      log.error('Error inesperado verificando integridad de DB:', error);
      return 'failed';
    }
  }

  /**
   * 2. Verifica conexión WebSocket al nodo XRPL.
   */
  private checkWebSocket(result: DiagnosticResult): 'ok' | 'disconnected' | 'reconnected' {
    if (this.client.isConnected()) {
      return 'ok';
    }

    result.warnings.push('WebSocket desconectado');
    log.warn('⚠️ WebSocket desconectado. El handler de reconexión debería estar activo.');
    return 'disconnected';
  }

  /**
   * 3. Verifica que el oráculo esté vivo y devolviendo precios recientes.
   */
  private async checkOracle(result: DiagnosticResult): Promise<'ok' | 'stale' | 'dead'> {
    if (!this.oracle) return 'ok'; // No inyectado, saltar check

    try {
      const health = this.oracle.getSourceHealth();
      const healthyCount = Object.values(health).filter(h => h.healthy).length;

      if (healthyCount === 0) {
        result.warnings.push('Todas las fuentes del oráculo fallaron');
        log.error('🔴 Oráculo MUERTO: 0 fuentes saludables.');
        return 'dead';
      }

      if (healthyCount < 2) {
        result.warnings.push(`Oráculo degradado: solo ${healthyCount} fuente(s) activa(s)`);
        return 'stale';
      }

      return 'ok';
    } catch {
      return 'dead';
    }
  }

  /**
   * 4. Detección anti-zombie: verifica que los ticks estén progresando.
   */
  private checkTickProgress(result: DiagnosticResult): 'ok' | 'stalled' | 'zombie' {
    // Primer ciclo: no hay referencia anterior
    if (this.cycleCount <= 1) return 'ok';

    const tickDelta = this.lastKnownTickCount - this.previousTickCount;
    const ledgerDelta = this.lastKnownLedger - this.previousLedger;

    // Si los ticks no avanzan pero los ledgers sí → zombie
    if (tickDelta === 0 && ledgerDelta > 0) {
      this.zombieStreak++;
    } else if (tickDelta === 0 && ledgerDelta === 0) {
      // Ni ticks ni ledgers: posible desconexión total
      this.zombieStreak++;
    } else {
      // Progreso normal
      this.zombieStreak = 0;
      return 'ok';
    }

    if (this.zombieStreak >= this.ZOMBIE_CRITICAL_CYCLES) {
      const msg = `🧟 ZOMBIE CRÍTICO: ${this.zombieStreak} ciclos sin ticks productivos. Ticks: ${this.lastKnownTickCount}, Ledger: ${this.lastKnownLedger}. Considerar reinicio.`;
      log.error(msg);
      result.warnings.push(msg);
      this.notifyCritical(msg);
      return 'zombie';
    }

    if (this.zombieStreak >= this.ZOMBIE_THRESHOLD_CYCLES) {
      const msg = `⚠️ Estado potencialmente zombie: ${this.zombieStreak} ciclos sin progreso de ticks.`;
      log.warn(msg);
      result.warnings.push(msg);
      return 'stalled';
    }

    return 'ok';
  }

  /**
   * 5. Verificar presión de memoria.
   */
  private checkMemory(result: DiagnosticResult): 'ok' | 'warning' | 'critical' {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    if (rssMB > this.MEMORY_CRITICAL_MB) {
      result.warnings.push(`Memoria CRÍTICA: ${rssMB}MB RSS`);
      log.error(`🔴 Memoria CRÍTICA: ${rssMB}MB RSS. Forzar GC o considerar reinicio.`);

      // Intentar forzar garbage collection si está disponible
      if (global.gc) {
        log.info('Forzando garbage collection...');
        global.gc();
      }
      return 'critical';
    }

    if (rssMB > this.MEMORY_WARNING_MB) {
      result.warnings.push(`Memoria alta: ${rssMB}MB RSS`);
      return 'warning';
    }

    return 'ok';
  }

  /**
   * 6. Verificar uso de disco del directorio data/.
   */
  private checkDisk(result: DiagnosticResult): 'ok' | 'warning' | 'critical' {
    try {
      const sizeMB = this.getDataDirSizeMB();

      if (sizeMB > this.DISK_CRITICAL_MB) {
        result.warnings.push(`Disco CRÍTICO: data/ = ${sizeMB.toFixed(1)}MB`);
        log.error(`🔴 Directorio data/ excede ${this.DISK_CRITICAL_MB}MB (${sizeMB.toFixed(1)}MB). Podar urgente.`);
        this.aggressivePrune();
        result.repairs.push('Poda agresiva de data/ ejecutada');
        return 'critical';
      }

      if (sizeMB > this.DISK_WARNING_MB) {
        result.warnings.push(`Disco alto: data/ = ${sizeMB.toFixed(1)}MB`);
        return 'warning';
      }

      return 'ok';
    } catch {
      return 'ok';
    }
  }

  // =====================================================================
  // PRUNING DE DB
  // =====================================================================

  /**
   * Podar datos viejos de la DB antes de que crezca demasiado.
   * Ejecutado en cada ciclo del watchdog para mantener la DB compacta.
   */
  private pruneDBIfNeeded(): void {
    try {
      if (!fs.existsSync(this.dbPath)) return;

      const stat = fs.statSync(this.dbPath);
      const sizeMB = stat.size / (1024 * 1024);

      // Solo podar si el archivo excede 1MB
      if (sizeMB < 1) return;

      const pruned = db.prune(150, 300);
      if (pruned) {
        log.info('📦 Poda de base de datos ejecutada con éxito a través del singleton.');
      }
    } catch (error) {
      log.error('Error durante poda de DB:', error);
    }
  }

  /**
   * Poda agresiva cuando el disco está críticamente lleno.
   * Elimina logs rotados y reduce la DB al mínimo.
   */
  private aggressivePrune(): void {
    try {
      // Eliminar logs rotados
      const logBase = path.join(this.dataDir, 'app_raw.log');
      for (let i = 1; i <= 5; i++) {
        const rotated = `${logBase}.${i}`;
        if (fs.existsSync(rotated)) {
          fs.unlinkSync(rotated);
          log.info(`🗑️ Eliminado log rotado: app_raw.log.${i}`);
        }
      }

      // Eliminar health log viejo
      const healthLog = path.join(this.dataDir, 'health_log.jsonl');
      if (fs.existsSync(healthLog)) {
        const stat = fs.statSync(healthLog);
        if (stat.size > 5 * 1024 * 1024) {
          // Mantener solo las últimas 100 líneas
          const content = fs.readFileSync(healthLog, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          const kept = lines.slice(-100);
          fs.writeFileSync(healthLog, kept.join('\n') + '\n', 'utf8');
          log.info(`🗑️ health_log.jsonl podado a 100 líneas.`);
        }
      }

      // Eliminar archivos .corrupt de DB
      const entries = fs.readdirSync(this.dataDir);
      for (const entry of entries) {
        if (entry.includes('.corrupt.')) {
          fs.unlinkSync(path.join(this.dataDir, entry));
          log.info(`🗑️ Eliminado backup corrupto: ${entry}`);
        }
      }
    } catch (error) {
      log.error('Error durante poda agresiva:', error);
    }
  }

  // =====================================================================
  // CHECKPOINT / PERSISTENCIA DE ESTADO
  // =====================================================================

  /**
   * Guarda el estado actual a disco para recuperación post-crash.
   */
  private saveCheckpoint(graceful: boolean): void {
    const state: CheckpointState = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      lastLedger: this.lastKnownLedger,
      lastTickCount: this.lastKnownTickCount,
      lastOraclePrice: this.lastOraclePrice,
      strategyName: this.strategyName,
      activeOrderSequences: this.activeOrderSequences,
      gracefulShutdown: graceful,
      watchdogCycleCount: this.cycleCount,
      zombieStreak: this.zombieStreak,
    };

    try {
      const tmpPath = this.checkpointPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.checkpointPath);
    } catch (error) {
      log.error('Error guardando checkpoint:', error);
    }
  }

  /**
   * Restaura el estado del último checkpoint (si existe).
   * Retorna el estado restaurado o null si no hay checkpoint.
   */
  private restoreCheckpoint(): CheckpointState | null {
    try {
      if (!fs.existsSync(this.checkpointPath)) return null;

      const raw = fs.readFileSync(this.checkpointPath, 'utf8');
      const state: CheckpointState = JSON.parse(raw);

      // Validar schema mínimo
      if (!state.timestamp || !state.sessionId) {
        log.warn('Checkpoint inválido. Ignorando.');
        return null;
      }

      // Restaurar contadores
      this.lastKnownLedger = state.lastLedger || 0;
      this.lastKnownTickCount = state.lastTickCount || 0;
      this.lastOraclePrice = state.lastOraclePrice || 0;
      this.zombieStreak = state.zombieStreak || 0;

      return state;
    } catch (error) {
      log.warn('Error restaurando checkpoint:', error);
      return null;
    }
  }

  /**
   * Obtiene el checkpoint actual para uso externo (ej. para restaurar órdenes).
   */
  getLastCheckpoint(): CheckpointState | null {
    try {
      if (!fs.existsSync(this.checkpointPath)) return null;
      const raw = fs.readFileSync(this.checkpointPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // =====================================================================
  // HELPERS
  // =====================================================================

  private getDataDirSizeMB(): number {
    try {
      if (!fs.existsSync(this.dataDir)) return 0;
      let totalBytes = 0;
      const entries = fs.readdirSync(this.dataDir);
      for (const entry of entries) {
        try {
          const stat = fs.statSync(path.join(this.dataDir, entry));
          if (stat.isFile()) totalBytes += stat.size;
        } catch { /* ignore */ }
      }
      return totalBytes / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  private generateSessionId(): string {
    const now = new Date();
    const date = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${date}_${rand}`;
  }

  private async notifyCritical(message: string): Promise<void> {
    if (this.telegram?.isConfigured()) {
      try {
        await this.telegram.sendCriticalAlert(`[Watchdog] ${message}`);
      } catch {
        // Best-effort
      }
    }
  }

  /**
   * Ejecutar diagnóstico bajo demanda (para health monitor o API).
   */
  async getStatus(): Promise<DiagnosticResult> {
    return this.runDiagnosticCycle();
  }

  /**
   * Obtener estadísticas del watchdog.
   */
  getStats(): { cycleCount: number; zombieStreak: number; sessionId: string; healthy: boolean } {
    return {
      cycleCount: this.cycleCount,
      zombieStreak: this.zombieStreak,
      sessionId: this.sessionId,
      healthy: this.zombieStreak < this.ZOMBIE_THRESHOLD_CYCLES,
    };
  }
}
