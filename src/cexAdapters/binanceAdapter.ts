import { AbstractCEXAdapter } from './AbstractCEXAdapter.js';
import { CEXTicker, CEXOrderResult, CEXBalance } from './ICEXAdapter.js';
import { config } from '../config.js';
import * as crypto from 'crypto';
import { apiFuse } from './apiFuse.js';
import { weightGovernor } from './weightGovernor.js';

export class BinanceAdapter extends AbstractCEXAdapter {
  readonly cexId = 'binance';

  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow = 5000;

  constructor() {
    super();
    this.apiKey = config.binanceApiKey;
    this.apiSecret = config.binanceApiSecret;
    this.baseUrl = config.binanceBaseUrl;
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  /**
   * Envoltorio seguro para fetch que implementa comprobaciones del fusible
   * y del gobernador de pesos de Binance, además de capturar telemetría.
   */
  private async safeFetch(url: string, init?: RequestInit): Promise<Response> {
    const caller = 'BinanceAdapter';
    
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

    // 3. Realizar petición real
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

    // 5. Capturar errores específicos de límites de peso o baneos
    if (!response.ok) {
      apiFuse.onErrorCode(response.status, `HTTP_${response.status}`);

      try {
        const cloned = response.clone();
        const errJson = await cloned.json() as any;
        if (errJson && typeof errJson.code === 'number') {
          apiFuse.onErrorCode(errJson.code, errJson.msg || '');
        }
      } catch {
        // Ignorar si no se puede parsear
      }
    }

    return response;
  }

  protected async performGetTicker(): Promise<CEXTicker | null> {
    const response = await this.safeFetch(`${this.baseUrl}/api/v3/ticker/bookTicker?symbol=XRPUSDT`);
    if (!response.ok) {
      throw new Error(`Binance HTTP error: ${response.status}`);
    }

    const data: any = await response.json();
    return {
      bidPrice: parseFloat(data.bidPrice),
      askPrice: parseFloat(data.askPrice),
      lastPrice: (parseFloat(data.bidPrice) + parseFloat(data.askPrice)) / 2,
      volume24h: 0,
      timestamp: Date.now()
    };
  }

  protected async performMarketBuy(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeBinanceOrder('BUY', qtyXrp);
  }

  protected async performMarketSell(qtyXrp: number): Promise<CEXOrderResult> {
    return this.executeBinanceOrder('SELL', qtyXrp);
  }

  protected async performLimitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult> {
    return this.executeBinanceOrder(side, qtyXrp, limitPrice, 'IOC');
  }

  protected async performGetBalances(): Promise<CEXBalance> {
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
      throw new Error(`Binance HTTP balance error: ${response.status}`);
    }

    const data: any = await response.json();
    const balances: any[] = data.balances || [];

    const xrpBal = balances.find((b: any) => b.asset === 'XRP');
    const usdtBal = balances.find((b: any) => b.asset === 'USDT');

    return {
      xrp: xrpBal ? parseFloat(xrpBal.free) : 0,
      usd: usdtBal ? parseFloat(usdtBal.free) : 0
    };
  }

  private async executeBinanceOrder(
    side: 'BUY' | 'SELL',
    qtyXrp: number,
    limitPrice?: number,
    timeInForce?: string
  ): Promise<CEXOrderResult> {
    const params: Record<string, string> = {
      symbol: 'XRPUSDT',
      side,
      quantity: this.formatQty(qtyXrp),
      newOrderRespType: 'FULL',
      timestamp: Date.now().toString(),
      recvWindow: this.recvWindow.toString()
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
        filledQty: 0,
        filledPrice: 0,
        commission: 0,
        commissionAsset: '',
        status: 'REJECTED',
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
      filledQty: totalFilledQty || parseFloat(data.executedQty || '0'),
      filledPrice: avgPrice || parseFloat(data.price || '0'),
      commission: totalCommission,
      commissionAsset: fills.length > 0 ? fills[0].commissionAsset : '',
      status: data.status
    };
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private formatQty(qty: number): string {
    return (Math.floor(qty * 10) / 10).toFixed(1); // XRP requiere 1 decimal en Binance
  }

  private formatPrice(price: number): string {
    return (Math.floor(price * 10000) / 10000).toFixed(4); // USDT requiere 4 decimales para XRPUSDT
  }
}
