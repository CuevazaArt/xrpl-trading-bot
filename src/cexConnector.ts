import { createLogger } from './logger.js';
import { config } from './config.js';
import * as crypto from 'crypto';

const log = createLogger('CEXConnector');

// =====================================================================
// TIPOS PÚBLICOS
// =====================================================================

export interface CEXOrderResult {
  success: boolean;
  orderId: string;
  filledQty: number;       // Cantidad realmente ejecutada
  filledPrice: number;     // Precio promedio de ejecución
  commission: number;      // Comisión pagada
  commissionAsset: string; // Moneda de la comisión
  status: string;          // FILLED, PARTIALLY_FILLED, EXPIRED, etc.
  error?: string;
}

export interface CEXBalance {
  xrp: number;
  usd: number;   // USDT en Binance
}

export interface CEXTicker {
  bidPrice: number;  // Mejor bid del CEX
  askPrice: number;  // Mejor ask del CEX
  lastPrice: number;
  volume24h: number;
  timestamp: number;
}

// =====================================================================
// BINANCE CEX CONNECTOR
// =====================================================================

/**
 * Conector para ejecutar operaciones en Binance.
 * 
 * Usa la API REST de Binance con autenticación HMAC-SHA256.
 * Soporta:
 * - Market orders (MARKET)
 * - Limit IOC orders (LIMIT + timeInForce=IOC)
 * - Consulta de balances
 * - Ticker en tiempo real
 * 
 * IMPORTANTE: Requiere BINANCE_API_KEY y BINANCE_API_SECRET en .env
 */
export class CEXConnector {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow: number = 5000;

  // Estado
  private lastTickerCache: CEXTicker | null = null;
  private lastTickerTime: number = 0;
  private readonly tickerCacheTtlMs: number = 1000; // 1s cache

  constructor() {
    this.apiKey = config.binanceApiKey;
    this.apiSecret = config.binanceApiSecret;
    this.baseUrl = config.binanceBaseUrl;

    if (!this.apiKey || !this.apiSecret) {
      log.warn('⚠️ BINANCE_API_KEY o BINANCE_API_SECRET no configurados. El conector CEX funcionará en modo READ-ONLY.');
    }
  }

  /**
   * Verifica si el conector está configurado para trading.
   */
  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  // =====================================================================
  // TICKER (PÚBLICO — no requiere auth)
  // =====================================================================

  /**
   * Obtiene el ticker actual de XRP/USDT en Binance.
   */
  async getTicker(): Promise<CEXTicker | null> {
    const now = Date.now();
    if (this.lastTickerCache && (now - this.lastTickerTime) < this.tickerCacheTtlMs) {
      return this.lastTickerCache;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/v3/ticker/bookTicker?symbol=XRPUSDT`);
      if (!response.ok) throw new Error(`Binance ticker: HTTP ${response.status}`);

      const data: any = await response.json();

      const ticker: CEXTicker = {
        bidPrice: parseFloat(data.bidPrice),
        askPrice: parseFloat(data.askPrice),
        lastPrice: (parseFloat(data.bidPrice) + parseFloat(data.askPrice)) / 2,
        volume24h: 0, // bookTicker no incluye volumen
        timestamp: now,
      };

      this.lastTickerCache = ticker;
      this.lastTickerTime = now;
      return ticker;
    } catch (error) {
      log.error('Error al obtener ticker de Binance:', error);
      return this.lastTickerCache; // Retornar caché stale si existe
    }
  }

  // =====================================================================
  // TRADING (REQUIERE AUTH)
  // =====================================================================

  /**
   * Ejecuta una orden de COMPRA de XRP en Binance (market order).
   * @param qtyXrp Cantidad de XRP a comprar
   */
  async marketBuy(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeOrder('BUY', qtyXrp);
  }

  /**
   * Ejecuta una orden de VENTA de XRP en Binance (market order).
   * @param qtyXrp Cantidad de XRP a vender
   */
  async marketSell(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeOrder('SELL', qtyXrp);
  }

  /**
   * Ejecuta una orden LIMIT IOC (Immediate-Or-Cancel) en Binance.
   * Solo ejecuta lo que pueda al precio dado o mejor, cancela el resto.
   */
  async limitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult> {
    return this.executeOrder(side, qtyXrp, limitPrice, 'IOC');
  }

  private async executeOrder(
    side: 'BUY' | 'SELL',
    qtyXrp: number,
    limitPrice?: number,
    timeInForce?: string
  ): Promise<CEXOrderResult> {
    if (!this.isConfigured()) {
      return {
        success: false, orderId: '', filledQty: 0, filledPrice: 0,
        commission: 0, commissionAsset: '', status: 'REJECTED',
        error: 'CEX Connector no configurado (faltan API keys)',
      };
    }

    try {
      const params: Record<string, string> = {
        symbol: 'XRPUSDT',
        side,
        quantity: this.formatQty(qtyXrp),
        newOrderRespType: 'FULL', // Retorna fills detallados
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString(),
      };

      if (limitPrice) {
        params.type = 'LIMIT';
        params.price = this.formatPrice(limitPrice);
        params.timeInForce = timeInForce || 'IOC';
      } else {
        params.type = 'MARKET';
      }

      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);

      const url = `${this.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;
      
      log.info(`CEX Order: ${side} ${qtyXrp} XRP ${limitPrice ? `@ ${limitPrice.toFixed(4)}` : 'MARKET'}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const data: any = await response.json();

      if (!response.ok) {
        const errMsg = data.msg || `HTTP ${response.status}`;
        log.error(`CEX Order rejected: ${errMsg}`, data);
        return {
          success: false, orderId: '', filledQty: 0, filledPrice: 0,
          commission: 0, commissionAsset: '', status: 'REJECTED',
          error: errMsg,
        };
      }

      // Parsear fills
      const fills: any[] = data.fills || [];
      const totalFilledQty = fills.reduce((sum: number, f: any) => sum + parseFloat(f.qty), 0);
      const totalFilledQuote = fills.reduce((sum: number, f: any) => sum + parseFloat(f.qty) * parseFloat(f.price), 0);
      const totalCommission = fills.reduce((sum: number, f: any) => sum + parseFloat(f.commission), 0);
      const avgPrice = totalFilledQty > 0 ? totalFilledQuote / totalFilledQty : 0;

      const result: CEXOrderResult = {
        success: data.status === 'FILLED' || data.status === 'PARTIALLY_FILLED',
        orderId: data.orderId?.toString() || '',
        filledQty: totalFilledQty || parseFloat(data.executedQty || '0'),
        filledPrice: avgPrice || parseFloat(data.price || '0'),
        commission: totalCommission,
        commissionAsset: fills.length > 0 ? fills[0].commissionAsset : '',
        status: data.status,
      };

      log.info(`CEX Order result: ${result.status} | Filled: ${result.filledQty} XRP @ ${result.filledPrice.toFixed(4)} | Commission: ${result.commission}`);
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(`CEX Order exception: ${errMsg}`);
      return {
        success: false, orderId: '', filledQty: 0, filledPrice: 0,
        commission: 0, commissionAsset: '', status: 'EXCEPTION',
        error: errMsg,
      };
    }
  }

  // =====================================================================
  // BALANCE (REQUIERE AUTH)
  // =====================================================================

  /**
   * Consulta los balances de XRP y USDT en Binance.
   */
  async getBalances(): Promise<CEXBalance> {
    if (!this.isConfigured()) {
      return { xrp: 0, usd: 0 };
    }

    try {
      const params: Record<string, string> = {
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString(),
      };

      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);

      const url = `${this.baseUrl}/api/v3/account?${queryString}&signature=${signature}`;

      const response = await fetch(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });

      if (!response.ok) {
        throw new Error(`Binance account: HTTP ${response.status}`);
      }

      const data: any = await response.json();
      const balances: any[] = data.balances || [];

      const xrpBal = balances.find((b: any) => b.asset === 'XRP');
      const usdtBal = balances.find((b: any) => b.asset === 'USDT');

      return {
        xrp: xrpBal ? parseFloat(xrpBal.free) : 0,
        usd: usdtBal ? parseFloat(usdtBal.free) : 0,
      };
    } catch (error) {
      log.error('Error al consultar balances de Binance:', error);
      return { xrp: 0, usd: 0 };
    }
  }

  // =====================================================================
  // CRYPTO UTILS
  // =====================================================================

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private formatQty(qty: number): string {
    // Binance XRP: stepSize = 0.1
    return (Math.floor(qty * 10) / 10).toFixed(1);
  }

  private formatPrice(price: number): string {
    // Binance XRP/USDT: tickSize = 0.0001
    return (Math.floor(price * 10000) / 10000).toFixed(4);
  }
}
