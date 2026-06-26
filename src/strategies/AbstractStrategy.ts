import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger, Logger } from '../logger.js';
import { IStrategy } from './IStrategy.js';

/**
 * Clase base abstracta para todas las estrategias del bot XRPL.
 *
 * Centraliza:
 * - Inicialización de dependencias (client, wallet, orderManager, dashboard)
 * - Consulta de balances (XRP + USD)
 * - Actualización base del dashboard (balances + db.logBalance)
 * - Constante del USD issuer
 *
 * Cada estrategia concreta extiende esta clase e implementa:
 * - `onInit()` para configuración específica
 * - `tick()` para lógica de trading
 * - `cleanup()` para limpieza antes de apagado
 */
export abstract class AbstractStrategy implements IStrategy {
  abstract readonly name: string;

  protected client!: Client;
  protected wallet!: Wallet;
  protected orderManager!: XRPLOrderManager;
  protected dashboard!: XRPLDashboard;
  protected log!: Logger;

  protected readonly usdIssuer = config.usdIssuer;

  async init(
    client: Client,
    wallet: Wallet,
    orderManager: XRPLOrderManager,
    dashboard: XRPLDashboard
  ): Promise<void> {
    this.client = client;
    this.wallet = wallet;
    this.orderManager = orderManager;
    this.dashboard = dashboard;
    this.log = createLogger(this.constructor.name);

    await this.onInit();
  }

  /**
   * Hook de inicialización específica de cada estrategia.
   * Se llama después de que las dependencias base están listas.
   */
  protected abstract onInit(): Promise<void>;

  abstract tick(currentLedger: number, marketPrice: number): Promise<void>;
  abstract cleanup(): Promise<void>;

  // =====================================================================
  // UTILIDADES COMPARTIDAS
  // =====================================================================

  /**
   * Consulta los balances de XRP y USD en una sola operación.
   * Evita duplicar el patrón getXrpBalance + account_lines + find USD
   * que estaba repetido en las 8 estrategias.
   */
  protected async fetchBalances(): Promise<{ xrpBalance: string; usdBalance: string }> {
    try {
      const xrpBalanceRaw = await this.client.getXrpBalance(this.wallet.address);
      const xrpBalance = String(xrpBalanceRaw);

      let usdBalance = '0';
      const linesResponse = await this.client.request({
        command: 'account_lines',
        account: this.wallet.address
      });
      const usdLine = linesResponse.result.lines.find(
        (line: any) => line.currency === 'USD' && line.account === this.usdIssuer
      );
      if (usdLine) {
        usdBalance = usdLine.balance;
      }

      return { xrpBalance, usdBalance };
    } catch (error) {
      this.log.error('Error al consultar balances:', error);
      return { xrpBalance: '0', usdBalance: '0' };
    }
  }

  /**
   * Actualiza balances en la DB y el dashboard con los datos proporcionados.
   * Las estrategias llaman a esto y le pasan los campos específicos de su contexto.
   */
  protected async updateDashboardWithBalances(
    specificState: Partial<Parameters<XRPLDashboard['updateState']>[0]>
  ): Promise<void> {
    try {
      const { xrpBalance, usdBalance } = await this.fetchBalances();
      db.logBalance(xrpBalance, usdBalance);

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        ...specificState,
      });
    } catch (error) {
      this.log.error('Error al actualizar dashboard:', error);
    }
  }
}
