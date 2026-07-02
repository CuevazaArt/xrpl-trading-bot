import { config } from '../config.js';
import * as crypto from 'crypto';
import { apiFuse } from './apiFuse.js';
import { weightGovernor } from './weightGovernor.js';
import { createLogger } from '../logger.js';

const log = createLogger('BinanceSpotClient');

export interface BinanceOrderResult {
  success: boolean;
  orderId: string;
  clientOrderId: string;
  status: string;
  filledQty: number;
  filledPrice: number;
  commission: number;
  commissionAsset: string;
  error?: string;
}

export interface BinanceSymbolFilter {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
}

export class BinanceSpotClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow = 5000;

  constructor() {
    this.apiKey = config.binanceApiKey;
    this.apiSecret = config.binanceApiSecret;
    this.baseUrl = config.binanceBaseUrl;
  }

  public isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  /**
   * Envoltorio seguro para fetch que implementa fusible y peso de Binance.
   */
  private async safeFetch(url: string, init?: RequestInit): Promise<Response> {
    const caller = 'BinanceSpotClient';

    // 1. Verificar fusible térmico (Fuse)
    if (apiFuse.isTripped()) {
      const remaining = apiFuse.remainingCooldownSeconds();
      throw new Error(`[API_FUSE] Petición abortada: Fusible térmico Binance disparado. Cooldown restante: ${remaining.toFixed(1)}s.`);
    }

    // 2. Consultar Gobernador de Pesos (Weight Governor)
    const wait = weightGovernor.requestPermission(caller);
    if (wait === Infinity) {
      throw new Error(`[WEIGHT_GOVERNOR] Petición bloqueada: Zona ROJA de consumo de peso en Binance (>80%).`);
    } else if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
    }

    // 3. Realizar petición
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (netErr: any) {
      throw new Error(`Error de red/conexión con Binance: ${netErr.message || netErr}`);
    }

    // 4. Capturar headers de peso de Binance
    if (response.headers && typeof response.headers.get === 'function') {
      const weightHeader = response.headers.get('x-mbx-used-weight-1m');
      if (weightHeader) {
        const weight = parseInt(weightHeader, 10);
        if (!isNaN(weight)) {
          weightGovernor.updateWeight(weight);
          apiFuse.checkWeight(weight);
        }
      }
    }

    // 5. Capturar errores específicos
    if (!response.ok) {
      apiFuse.onErrorCode(response.status, `HTTP_${response.status}`);
      try {
        const cloned = response.clone();
        const errJson = await cloned.json() as any;
        if (errJson && typeof errJson.code === 'number') {
          apiFuse.onErrorCode(errJson.code, errJson.msg || '');
        }
      } catch {
        // Ignorar
      }
    }

    return response;
  }

  /**
   * Obtiene las cotizaciones de TODOS los pares de Binance Spot en una sola llamada (peso = 2).
   */
  async getAllTickerPrices(): Promise<Record<string, number>> {
    try {
      const response = await this.safeFetch(`${this.baseUrl}/api/v3/ticker/price`);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = (await response.json()) as Array<{ symbol: string; price: string }>;
      const result: Record<string, number> = {};
      for (const item of data) {
        result[item.symbol.toUpperCase()] = parseFloat(item.price);
      }
      return result;
    } catch (error: any) {
      log.error(`Error obteniendo precios masivos de Binance:`, error.message || error);
      return {};
    }
  }

  /**
   * Obtiene la cotización actual para un símbolo (ej: FARMUSDT).
   */
  async getTickerPrice(symbol: string): Promise<number> {
    try {
      const response = await this.safeFetch(`${this.baseUrl}/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = (await response.json()) as { price: string };
      return parseFloat(data.price);
    } catch (error: any) {
      log.error(`Error obteniendo precio para ${symbol}:`, error.message || error);
      return 0;
    }
  }

  /**
   * Obtiene balances de la cuenta (retorna mapa de Asset -> saldo libre).
   */
  async getBalances(): Promise<Record<string, number>> {
    try {
      const params: Record<string, string> = {
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString()
      };
      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);
      const url = `${this.baseUrl}/api/v3/account?${queryString}&signature=${signature}`;

      const response = await this.safeFetch(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey }
      });

      if (!response.ok) {
        throw new Error(`HTTP balance error ${response.status}`);
      }

      const data: any = await response.json();
      const balances: any[] = data.balances || [];
      const result: Record<string, number> = {};

      for (const bal of balances) {
        const free = parseFloat(bal.free);
        if (free > 0) {
          result[bal.asset.toUpperCase()] = free;
        }
      }

      return result;
    } catch (error: any) {
      log.error(`Error obteniendo balances de Binance:`, error.message || error);
      return {};
    }
  }

  /**
   * Ejecuta una orden Spot en Binance.
   */
  async executeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'LIMIT' | 'MARKET',
    quantity: string,
    price?: string,
    timeInForce?: 'GTC' | 'IOC' | 'FOK'
  ): Promise<BinanceOrderResult> {
    try {
      const params: Record<string, string> = {
        symbol: symbol.toUpperCase(),
        side,
        type,
        quantity,
        newOrderRespType: 'FULL',
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString()
      };

      if (type === 'LIMIT') {
        if (!price) throw new Error('Price is required for LIMIT orders');
        params.price = price;
        params.timeInForce = timeInForce || 'GTC';
      }

      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);
      const url = `${this.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;

      const response = await this.safeFetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const data: any = await response.json();

      if (!response.ok) {
        const errMsg = data.msg || `HTTP ${response.status}`;
        return {
          success: false,
          orderId: '',
          clientOrderId: '',
          status: 'REJECTED',
          filledQty: 0,
          filledPrice: 0,
          commission: 0,
          commissionAsset: '',
          error: errMsg
        };
      }

      const fills: any[] = data.fills || [];
      const totalFilledQty = fills.reduce((sum: number, f: any) => sum + parseFloat(f.qty), 0);
      const totalFilledQuote = fills.reduce((sum: number, f: any) => sum + parseFloat(f.qty) * parseFloat(f.price), 0);
      const totalCommission = fills.reduce((sum: number, f: any) => sum + parseFloat(f.commission), 0);
      const avgPrice = totalFilledQty > 0 ? totalFilledQuote / totalFilledQty : 0;

      return {
        success: data.status === 'FILLED' || data.status === 'PARTIALLY_FILLED',
        orderId: data.orderId?.toString() || '',
        clientOrderId: data.clientOrderId || '',
        status: data.status,
        filledQty: totalFilledQty || parseFloat(data.executedQty || '0'),
        filledPrice: avgPrice || parseFloat(data.price || '0'),
        commission: totalCommission,
        commissionAsset: fills.length > 0 ? fills[0].commissionAsset : ''
      };
    } catch (error: any) {
      log.error(`Error ejecutando orden ${side} ${type} en ${symbol}:`, error.message || error);
      return {
        success: false,
        orderId: '',
        clientOrderId: '',
        status: 'EXCEPTION',
        filledQty: 0,
        filledPrice: 0,
        commission: 0,
        commissionAsset: '',
        error: error.message || String(error)
      };
    }
  }

  /**
   * Cancela una orden activa.
   */
  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const params: Record<string, string> = {
        symbol: symbol.toUpperCase(),
        orderId,
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString()
      };

      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);
      const url = `${this.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;

      const response = await this.safeFetch(url, {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': this.apiKey }
      });

      const data: any = await response.json();
      if (!response.ok) {
        return { success: false, error: data.msg || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error: any) {
      log.error(`Error cancelando orden ${orderId} en ${symbol}:`, error.message || error);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Obtiene las órdenes pendientes (abiertas) en Binance Spot.
   */
  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      const params: Record<string, string> = {
        timestamp: Date.now().toString(),
        recvWindow: this.recvWindow.toString()
      };
      if (symbol) {
        params.symbol = symbol.toUpperCase();
      }
      const queryString = new URLSearchParams(params).toString();
      const signature = this.sign(queryString);
      const url = `${this.baseUrl}/api/v3/openOrders?${queryString}&signature=${signature}`;

      const response = await this.safeFetch(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey }
      });

      if (!response.ok) {
        throw new Error(`HTTP openOrders error ${response.status}`);
      }

      return (await response.json()) as any[];
    } catch (error: any) {
      log.error(`Error obteniendo órdenes abiertas:`, error.message || error);
      return [];
    }
  }

  /**
   * Obtiene la información de filtros (minNotional, stepSize, etc) para múltiples símbolos.
   */
  async getExchangeInfo(symbols?: string[]): Promise<Record<string, BinanceSymbolFilter>> {
    try {
      let queryStr = '';
      if (symbols && symbols.length > 0) {
        const formatted = JSON.stringify(symbols.map(s => s.toUpperCase()));
        queryStr = `?symbols=${encodeURIComponent(formatted)}`;
      }
      const response = await this.safeFetch(`${this.baseUrl}/api/v3/exchangeInfo${queryStr}`);
      if (!response.ok) {
        throw new Error(`HTTP exchangeInfo error ${response.status}`);
      }

      const data = (await response.json()) as { symbols: any[] };
      const result: Record<string, BinanceSymbolFilter> = {};

      for (const s of data.symbols) {
        const sym = s.symbol.toUpperCase();
        
        let minPrice = 0, maxPrice = 0, tickSize = 0;
        let minQty = 0, maxQty = 0, stepSize = 0;
        let minNotional = 0;

        const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        if (priceFilter) {
          minPrice = parseFloat(priceFilter.minPrice);
          maxPrice = parseFloat(priceFilter.maxPrice);
          tickSize = parseFloat(priceFilter.tickSize);
        }

        const lotSize = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        if (lotSize) {
          minQty = parseFloat(lotSize.minQty);
          maxQty = parseFloat(lotSize.maxQty);
          stepSize = parseFloat(lotSize.stepSize);
        }

        const notionalFilter = s.filters.find((f: any) => f.filterType === 'NOTIONAL');
        if (notionalFilter) {
          minNotional = parseFloat(notionalFilter.minNotional);
        }

        result[sym] = {
          symbol: sym,
          status: s.status,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          minPrice,
          maxPrice,
          tickSize,
          minQty,
          maxQty,
          stepSize,
          minNotional
        };
      }

      return result;
    } catch (error: any) {
      log.error(`Error obteniendo exchangeInfo de Binance:`, error.message || error);
      return {};
    }
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }
}
