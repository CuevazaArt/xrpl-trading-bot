import { createLogger } from './logger.js';
import { ICEXAdapter, CEXOrderResult, CEXBalance, CEXTicker } from './cexAdapters/ICEXAdapter.js';
import { BinanceAdapter } from './cexAdapters/binanceAdapter.js';

const log = createLogger('CEXConnector');

export { CEXOrderResult, CEXBalance, CEXTicker };

/**
 * Facade de Conectores CEX de Helena.
 * 
 * Actúa como envoltorio retro-compatible de los adaptadores modulares plug-and-play.
 * Por defecto carga BinanceAdapter, pero puede extenderse para cargar cualquier otro
 * conector que implemente ICEXAdapter de forma transparente.
 */
export class CEXConnector {
  private activeAdapter: ICEXAdapter;

  constructor(adapter?: ICEXAdapter) {
    // Si no se inyecta adaptador, usamos Binance por defecto (retro-compatibilidad)
    this.activeAdapter = adapter || new BinanceAdapter();
    log.info(`Cargado adaptador CEX activo: '${this.activeAdapter.cexId}'`);
  }

  /**
   * Obtiene el identificador del adaptador actual.
   */
  getAdapterId(): string {
    return this.activeAdapter.cexId;
  }

  /**
   * Getter y Setter retro-compatible para el control de expiración del caché en los tests.
   */
  get lastTickerTime(): number {
    return (this.activeAdapter as any).lastTickerTime || 0;
  }

  set lastTickerTime(val: number) {
    if ((this.activeAdapter as any).lastTickerTime !== undefined) {
      (this.activeAdapter as any).lastTickerTime = val;
    }
  }

  /**
   * Verifica si el conector está configurado para trading.
   */
  isConfigured(): boolean {
    return this.activeAdapter.isConfigured();
  }

  /**
   * Obtiene el ticker actual de XRP/USDT del CEX.
   */
  async getTicker(): Promise<CEXTicker | null> {
    return this.activeAdapter.getTicker();
  }

  /**
   * Ejecuta una orden de COMPRA de XRP (market order).
   */
  async marketBuy(qtyXrp: number): Promise<CEXOrderResult> {
    return this.activeAdapter.marketBuy(qtyXrp);
  }

  /**
   * Ejecuta una orden de VENTA de XRP (market order).
   */
  async marketSell(qtyXrp: number): Promise<CEXOrderResult> {
    return this.activeAdapter.marketSell(qtyXrp);
  }

  /**
   * Ejecuta una orden LIMIT IOC (Immediate-Or-Cancel).
   */
  async limitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult> {
    return this.activeAdapter.limitIOC(side, qtyXrp, limitPrice);
  }

  /**
   * Consulta los balances de XRP y USD.
   */
  async getBalances(): Promise<CEXBalance> {
    return this.activeAdapter.getBalances();
  }
}
