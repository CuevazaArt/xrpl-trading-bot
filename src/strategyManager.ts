import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { XRPLDashboard } from './dashboard.js';
import { createLogger } from './logger.js';
import { config } from './config.js';
import { createStrategy, IStrategy } from './strategies/index.js';

const log = createLogger('StrategyManager');

export class XRPLStrategyManager {
  private client: Client;
  private wallet: Wallet;
  private orderManager: XRPLOrderManager;
  private dashboard: XRPLDashboard;

  // Estrategia activa cargada desde la fábrica
  private strategy: IStrategy;

  // Estado del ledger
  private currentLedger: number = 0;
  private tickCount: number = 0;

  constructor(client: Client, wallet: Wallet, dashboard: XRPLDashboard) {
    this.client = client;
    this.wallet = wallet;
    this.dashboard = dashboard;
    this.orderManager = new XRPLOrderManager(client);

    // Cargar la estrategia activa según la variable de entorno STRATEGY
    log.info(`Cargando estrategia: '${config.strategy}'`);
    this.strategy = createStrategy(config.strategy);
  }

  /**
   * Arranca la estrategia escuchando cierres de ledgers y tomando decisiones
   */
  async start() {
    log.info(`Iniciando orquestador de estrategias para bot '${this.strategy.name}'...`);

    // Inicializar la estrategia cargada
    await this.strategy.init(this.client, this.wallet, this.orderManager, this.dashboard);

    // Suscribirse al stream de ledgers para recibir los eventos
    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger']
      });
    } catch (error) {
      log.error('Error al suscribirse al stream de ledgers en el orquestador:', error);
    }

    // Escuchar cierres de ledger para ejecutar la reevaluación periódica (tick)
    this.client.connection.on('ledgerClosed', async (ledger) => {
      this.currentLedger = ledger.ledger_index;
      this.tickCount++;
      log.info(`--- Tick #${this.tickCount} en Ledger #${this.currentLedger} [Bot: ${this.strategy.name}] ---`);
      try {
        await this.tick();
      } catch (error) {
        log.error(`Error durante el tick de la estrategia '${this.strategy.name}':`, error);
      }
    });
  }

  /**
   * Ciclo principal ejecutado en cada bloque
   */
  private async tick() {
    // 1. Consultar precio de referencia desde el oráculo (Coinbase)
    const marketPrice = await this.getFairPrice();
    if (marketPrice <= 0) {
      log.warn('No se pudo calcular el precio del oráculo. Saltando ciclo...');
      return;
    }

    log.debug(`Precio Oráculo: ${marketPrice.toFixed(4)} USD`);

    // 2. Ejecutar tick de la estrategia activa
    await this.strategy.tick(this.currentLedger, marketPrice);
  }

  /**
   * Consulta el precio real de mercado (spot) de XRP/USD desde la API pública de Coinbase
   * para usarlo como precio justo de referencia.
   */
  private async getFairPrice(): Promise<number> {
    try {
      const response = await fetch('https://api.coinbase.com/v2/prices/XRP-USD/spot');
      if (!response.ok) {
        throw new Error(`Coinbase API returned status ${response.status}`);
      }
      const data: any = await response.json();
      const price = parseFloat(data.data.amount);
      if (!isNaN(price) && price > 0) {
        return price;
      }
      return 0.50; // Fallback
    } catch (error) {
      log.warn('No se pudo obtener el precio de Coinbase. Usando fallback (0.50 USD).', (error as any).message);
      return 0.50;
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
