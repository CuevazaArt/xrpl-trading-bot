import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { XRPLWalletManager } from './walletManager.js';
import { XRPLDashboard } from './dashboard.js';
import { createLogger } from './logger.js';
import { config } from './config.js';
import { createStrategy, IStrategy } from './strategies/index.js';
import { MultiOracle } from './multiOracle.js';
import { PaperOrderManager } from './paperTrading.js';
import { HealthMonitor } from './healthMonitor.js';
import { CLIDashboard } from './cliDashboard.js';

const log = createLogger('StrategyManager');

const TICK_TIMEOUT_MS = 15_000; // 15 segundos máximo por tick

export class XRPLStrategyManager {
  private client: Client;
  private wallet: Wallet;
  private orderManager: XRPLOrderManager;
  private walletManager: XRPLWalletManager;
  private dashboard: XRPLDashboard;
  private multiOracle: MultiOracle;

  // Estrategia activa cargada desde la fábrica
  private strategy: IStrategy;

  // Estado del ledger
  private currentLedger: number = 0;
  private tickCount: number = 0;
  private tickInProgress: boolean = false;

  // Observadores opcionales (inyectados desde index.ts)
  private healthMonitor: HealthMonitor | null = null;
  private cliDash: CLIDashboard | null = null;
  private paperOrderManager: PaperOrderManager | null = null;

  constructor(
    client: Client,
    wallet: Wallet,
    walletManager: XRPLWalletManager,
    multiOracle: MultiOracle,
    dashboard: XRPLDashboard,
    paperOrderManager?: PaperOrderManager
  ) {
    this.client = client;
    this.wallet = wallet;
    this.dashboard = dashboard;
    this.multiOracle = multiOracle;
    this.walletManager = walletManager;

    // Paper trading: inyectar PaperOrderManager en vez del real
    if (paperOrderManager) {
      this.orderManager = paperOrderManager;
      this.paperOrderManager = paperOrderManager;
      log.info('📝 OrderManager: usando PaperOrderManager (modo simulado)');
    } else {
      this.orderManager = new XRPLOrderManager(client);
    }

    // Cargar la estrategia activa según la variable de entorno STRATEGY
    log.info(`Cargando estrategia: '${config.strategy}'`);
    this.strategy = createStrategy(config.strategy);
  }

  /**
   * Inyecta el health monitor para updates por tick.
   */
  setHealthMonitor(monitor: HealthMonitor): void {
    this.healthMonitor = monitor;
  }

  /**
   * Inyecta el CLI dashboard para rendering en cada tick.
   */
  setCliDashboard(cliDash: CLIDashboard): void {
    this.cliDash = cliDash;
  }

  /**
   * Arranca la estrategia escuchando cierres de ledgers y tomando decisiones
   */
  async start() {
    log.info(`Iniciando orquestador de estrategias para bot '${this.strategy.name}'...`);

    // Inicializar la estrategia cargada
    await this.strategy.init(this.client, this.wallet, this.orderManager, this.dashboard);

    // Suscribirse al stream de ledgers
    await this.resubscribeLedger();

    // Escuchar cierres de ledger para ejecutar la reevaluación periódica (tick)
    // El listener se agrega UNA sola vez aquí. resubscribeLedger() solo re-envía
    // el comando 'subscribe' al server sin agregar listeners duplicados.
    this.client.connection.on('ledgerClosed', async (ledger) => {
      // Guard: verificar conexión activa
      if (!this.client.isConnected()) {
        log.warn('Evento ledgerClosed recibido pero client desconectado. Saltando tick.');
        return;
      }

      // Guard: evitar ticks concurrentes (si el anterior no terminó)
      if (this.tickInProgress) {
        log.warn(`Tick anterior aún en progreso. Saltando ledger #${ledger.ledger_index}.`);
        return;
      }

      this.currentLedger = ledger.ledger_index;
      this.tickCount++;
      this.tickInProgress = true;
      // Only log tick header every 30 ticks (~90s) to reduce noise
      if (this.tickCount % 30 === 0) {
        log.info(`Tick #${this.tickCount} | Ledger #${this.currentLedger}`);
      }
      try {
        // Timeout guard: evitar que un RPC colgado congele el bot indefinidamente
        await Promise.race([
          this.tick(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tick timeout: superó ${TICK_TIMEOUT_MS / 1000}s`)), TICK_TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        log.error(`Error durante el tick de la estrategia '${this.strategy.name}':`, error);
      } finally {
        this.tickInProgress = false;
      }
    });
  }

  /**
   * Ciclo principal ejecutado en cada bloque
   */
  private async tick() {
    // 0. Verificar si la billetera tiene suficiente reserva de XRP
    const hasReserve = await this.walletManager.hasEnoughReserve();
    if (!hasReserve) {
      log.warn('Saltando ciclo de trading: Saldo de XRP inferior al límite de reserva configurado.');
      return;
    }

    // 1. Consultar precio de referencia desde el oráculo multi-fuente
    const consensus = await this.multiOracle.getConsensusPrice();
    if (!consensus || consensus.price <= 0) {
      log.warn('No se pudo obtener precio de consenso (fuentes insuficientes). Saltando ciclo...');
      return;
    }

    const marketPrice = consensus.price;

    if (consensus.confidence < 0.5) {
      const health = this.multiOracle.getSourceHealth();
      const healthyCount = Object.values(health).filter(h => h.healthy).length;
      log.warn(`Oráculo degradado (${healthyCount}/4 fuentes, confianza: ${(consensus.confidence * 100).toFixed(0)}%). Operando con precio disponible.`);
    }

    log.debug(`Precio Oráculo: ${marketPrice.toFixed(4)} USD (${consensus.sources.filter(s => s.healthy).length} fuentes, ${(consensus.confidence * 100).toFixed(0)}% conf)`);

    // 2. Actualizar precio en PaperOrderManager (si activo)
    if (this.paperOrderManager) {
      this.paperOrderManager.setOraclePrice(marketPrice);
      // Tomar snapshot periódico (cada 10 ticks)
      if (this.tickCount % 10 === 0) {
        this.paperOrderManager.getDB().takeSnapshot(marketPrice);
      }
    }

    // 3. Ejecutar tick de la estrategia activa
    await this.strategy.tick(this.currentLedger, marketPrice);

    // 4. Actualizar Health Monitor (si inyectado)
    if (this.healthMonitor) {
      this.healthMonitor.updateLedgerState(
        this.currentLedger,
        this.tickCount,
        this.strategy.name
      );
    }

    // 5. Actualizar CLI Dashboard (si inyectado)
    if (this.cliDash && this.healthMonitor) {
      try {
        const snapshot = await this.healthMonitor.getSnapshot();
        this.cliDash.update(snapshot);
      } catch (err) {
        log.error('Error actualizando CLI dashboard:', err);
      }
    }
  }

  /**
   * Re-suscribe al stream de ledgers del servidor XRPL.
   * Llamar después de una reconexión WebSocket para restaurar el feed de eventos.
   * No agrega listeners duplicados — solo re-envía el comando 'subscribe'.
   */
  async resubscribeLedger() {
    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger']
      });
      log.info('Suscripción a ledger stream restaurada.');
    } catch (error) {
      log.error('Error al suscribirse al stream de ledgers:', error);
    }
  }

  /**
   * Limpia recursos y cancela órdenes antes de apagar
   */
  async cancelAllOrders() {
    log.info(`Apagando orquestador. Ejecutando limpieza para '${this.strategy.name}'...`);
    try {
      await this.strategy.cleanup();
    } catch (error) {
      log.error(`Error al realizar limpieza de la estrategia '${this.strategy.name}':`, error);
    }
    log.info('Limpieza completada.');
  }
}
