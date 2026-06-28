import { ICEXAdapter, CEXTicker, CEXOrderResult, CEXBalance } from './ICEXAdapter.js';
import { createLogger } from '../logger.js';

export abstract class AbstractCEXAdapter implements ICEXAdapter {
  abstract readonly cexId: string;
  protected log: ReturnType<typeof createLogger>;

  constructor() {
    this.log = createLogger(`CEX:${this.constructor.name}`);
  }

  abstract isConfigured(): boolean;

  protected lastTickerCache: CEXTicker | null = null;
  public lastTickerTime: number = 0;
  protected readonly tickerCacheTtlMs: number = 1000; // 1s

  async getTicker(): Promise<CEXTicker | null> {
    const now = Date.now();
    if (this.lastTickerCache && (now - this.lastTickerTime) < this.tickerCacheTtlMs) {
      return this.lastTickerCache;
    }

    const TIMEOUT_MS = 3000; // 3s timeout
    try {
      const ticker = await Promise.race([
        this.performGetTicker(),
        new Promise<CEXTicker>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de ticker (3s)')), TIMEOUT_MS)
        )
      ]);
      if (ticker) {
        this.lastTickerCache = ticker;
        this.lastTickerTime = now;
      }
      return ticker;
    } catch (error: any) {
      this.log.error(`Error al obtener ticker de ${this.cexId}:`, error.message || error);
      return this.lastTickerCache; // Retornar caché stale si existe
    }
  }

  protected abstract performGetTicker(): Promise<CEXTicker | null>;

  async marketBuy(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeOrderWithSafety(() => this.performMarketBuy(qtyXrp), 'BUY MARKET');
  }

  async marketSell(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeOrderWithSafety(() => this.performMarketSell(qtyXrp), 'SELL MARKET');
  }

  async limitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult> {
    return this.executeOrderWithSafety(() => this.performLimitIOC(side, qtyXrp, limitPrice), `${side} LIMIT IOC`);
  }

  async getBalances(): Promise<CEXBalance> {
    if (!this.isConfigured()) {
      return { xrp: 0, usd: 0 };
    }
    const TIMEOUT_MS = 5000;
    try {
      return await Promise.race([
        this.performGetBalances(),
        new Promise<CEXBalance>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de balances (5s)')), TIMEOUT_MS)
        )
      ]);
    } catch (error: any) {
      this.log.error(`Error al obtener balances:`, error.message || error);
      return { xrp: 0, usd: 0 };
    }
  }

  protected abstract performGetBalances(): Promise<CEXBalance>;
  protected abstract performMarketBuy(qtyXrp: number): Promise<CEXOrderResult>;
  protected abstract performMarketSell(qtyXrp: number): Promise<CEXOrderResult>;
  protected abstract performLimitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult>;

  private async executeOrderWithSafety(action: () => Promise<CEXOrderResult>, desc: string): Promise<CEXOrderResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        orderId: '',
        filledQty: 0,
        filledPrice: 0,
        commission: 0,
        commissionAsset: '',
        status: 'REJECTED',
        error: 'Adaptador no configurado (faltan API keys)'
      };
    }

    const TIMEOUT_MS = 8000; // 8s timeout para ejecución
    try {
      this.log.info(`Enviando orden ${desc}...`);
      const result = await Promise.race([
        action(),
        new Promise<CEXOrderResult>((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout de orden ${desc} (8s)`)), TIMEOUT_MS)
        )
      ]);

      if (result.success) {
        this.log.info(`✅ Orden ${desc} ejecutada con éxito. ID: ${result.orderId}`);
      } else {
        this.log.error(`❌ Orden ${desc} rechazada por el CEX: ${result.error || result.status}`);
      }
      return result;
    } catch (error: any) {
      this.log.error(`Excepción fatal durante la orden ${desc}:`, error.message || error);
      return {
        success: false,
        orderId: '',
        filledQty: 0,
        filledPrice: 0,
        commission: 0,
        commissionAsset: '',
        status: 'EXCEPTION',
        error: error.message || String(error)
      };
    }
  }
}
