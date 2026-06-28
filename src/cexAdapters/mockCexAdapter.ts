import { AbstractCEXAdapter } from './AbstractCEXAdapter.js';
import { CEXTicker, CEXOrderResult, CEXBalance } from './ICEXAdapter.js';

export class MockCEXAdapter extends AbstractCEXAdapter {
  readonly cexId = 'mock_cex';

  isConfigured(): boolean {
    return true;
  }

  protected async performGetTicker(): Promise<CEXTicker | null> {
    return {
      bidPrice: 1.0450,
      askPrice: 1.0460,
      lastPrice: 1.0455,
      volume24h: 1500000,
      timestamp: Date.now()
    };
  }

  protected async performMarketBuy(qtyXrp: number): Promise<CEXOrderResult> {
    return {
      success: true,
      orderId: 'MOCK_CEX_BUY_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      filledQty: qtyXrp,
      filledPrice: 1.0460,
      commission: qtyXrp * 0.001,
      commissionAsset: 'USDT',
      status: 'FILLED'
    };
  }

  protected async performMarketSell(qtyXrp: number): Promise<CEXOrderResult> {
    return {
      success: true,
      orderId: 'MOCK_CEX_SELL_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      filledQty: qtyXrp,
      filledPrice: 1.0450,
      commission: qtyXrp * 0.001,
      commissionAsset: 'XRP',
      status: 'FILLED'
    };
  }

  protected async performLimitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult> {
    return {
      success: true,
      orderId: 'MOCK_CEX_IOC_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      filledQty: qtyXrp,
      filledPrice: limitPrice,
      commission: qtyXrp * 0.001,
      commissionAsset: side === 'BUY' ? 'USDT' : 'XRP',
      status: 'FILLED'
    };
  }

  protected async performGetBalances(): Promise<CEXBalance> {
    return {
      xrp: 500,
      usd: 1000
    };
  }
}
