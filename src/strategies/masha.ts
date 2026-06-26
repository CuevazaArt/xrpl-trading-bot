import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface MashaRung { price: number; qty: number; timestamp: number; }
interface MashaState { epochId: string; rungs: MashaRung[]; sellSequence?: number; sellPrice?: number; }

export class XRPLMashaStrategy extends AbstractStrategy {
  public readonly name = 'masha';
  private state: MashaState = { epochId: '', rungs: [] };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Masha Multi-Timeframe DCA' });
    this.log.info(`Masha initialized: profit_factor=${config.mashaProfitFactor}%, periods_1w=${config.mashaMaPeriods1w}, periods_1h=${config.mashaMaPeriods1h}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    await this.syncSellOrder();
    const { weakness1w, weakness1h, ma1w, ma1h } = await this.checkDoubleWeakness(marketPrice);
    this.log.info(`Masha Signals: Weekly MA(${config.mashaMaPeriods1w})=${ma1w.toFixed(4)} (Weakness=${weakness1w}) | Hourly MA(${config.mashaMaPeriods1h})=${ma1h.toFixed(4)} (Weakness=${weakness1h})`);

    const doubleWeakness = weakness1w && weakness1h;
    const canAccumulate = this.state.rungs.length < config.maxRungs;

    if (doubleWeakness && canAccumulate) {
      this.log.info(`Masha Double Weakness triggered! Accumulating DCA rung #${this.state.rungs.length + 1}...`);
      await this.executeBuy(marketPrice);
    }
  }

  async cleanup(): Promise<void> { this.log.info('Cleanup: Masha keeping consolidated sell limit order active.'); }

  private async syncSellOrder() {
    if (!this.state.sellSequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.sellSequence)) {
        this.log.info(`Masha: Consolidated Sell Limit TP order filled! (Seq: ${this.state.sellSequence})`);
        db.logTransaction('MASHA_TP_FILLED', '', 'FILLED', {
          avgPrice: (this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0) / this.state.rungs.reduce((acc, r) => acc + r.qty, 0)),
          sellPrice: this.state.sellPrice, totalQty: this.state.rungs.reduce((acc, r) => acc + r.qty, 0)
        });
        this.state = { epochId: '', rungs: [] };
        this.saveState();
      }
    } catch (error) { this.log.error('Masha: Error checking active sell offers:', error); }
  }

  private async executeBuy(price: number) {
    const buyQty = config.mashaBuyQtyBase;
    const maxBuyPrice = price * 1.01;
    const usdCost = (buyQty * maxBuyPrice).toFixed(4);
    const takerPays = (buyQty * 1000000).toString();
    const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

    this.log.info(`Masha: Placing Spot Buy order of ${buyQty} XRP (max limit: ${maxBuyPrice.toFixed(4)})`);
    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!buyResult.success || !buyResult.sequence) { this.log.error('Masha: Buy order failed:', buyResult.error); return; }

      db.logTransaction('MASHA_BUY', buyResult.hash || '', 'tesSUCCESS', { price, amount: buyQty });
      this.state.rungs.push({ price, qty: buyQty, timestamp: Date.now() });
      if (!this.state.epochId) this.state.epochId = `epoch_masha_${Date.now()}`;

      await this.placeConsolidatedTP();
      this.saveState();
    } catch (error) { this.log.error('Masha: Exception during buy:', error); }
  }

  private async placeConsolidatedTP() {
    if (this.state.sellSequence) {
      this.log.info(`Masha: Canceling previous TP (Seq: ${this.state.sellSequence})`);
      await this.orderManager.cancelOrder(this.wallet, this.state.sellSequence);
      this.state.sellSequence = undefined; this.state.sellPrice = undefined;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalCost = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalCost / totalVolume;
    const sellPrice = parseFloat((avgPrice * (1 + config.mashaProfitFactor / 100)).toFixed(4));
    const totalUsdValue = (totalVolume * sellPrice).toFixed(4);

    const sellTakerPays = { currency: 'USD', value: totalUsdValue, issuer: this.usdIssuer };
    const sellTakerGets = (totalVolume * 1000000).toString();

    this.log.info(`Masha: Placing consolidated TP Sell order of ${totalVolume} XRP at ${sellPrice.toFixed(4)} USD`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, sellTakerPays, sellTakerGets);
      if (sellResult.success && sellResult.sequence !== undefined) {
        this.state.sellSequence = sellResult.sequence; this.state.sellPrice = sellPrice;
        db.logTransaction('MASHA_TP_LIMIT', sellResult.hash || '', 'tesSUCCESS', { price: sellPrice, amount: totalVolume });
      } else { this.log.error('Masha: Consolidated TP placement failed:', sellResult.error); }
    } catch (error) { this.log.error('Masha: Exception placing consolidated TP:', error); }

    await this.updateDashboardWithBalances({
      midPrice: avgPrice.toString(), buyTarget: 'Double Weakness Trigger', sellTarget: (sellPrice || 0).toString(),
      activeBuySeq: `Rungs: ${this.state.rungs.length}`,
      activeSellSeq: this.state.sellSequence ? `TP Seq: ${this.state.sellSequence}` : 'Ninguna',
      strategyName: 'Masha DCA MTF', activeRungs: `${this.state.rungs.length} / ${config.maxRungs}`,
      botStatus: `Running (Avg: ${avgPrice.toFixed(4)})`
    });
  }

  private async checkDoubleWeakness(currentPrice: number): Promise<{ weakness1w: boolean; weakness1h: boolean; ma1w: number; ma1h: number }> {
    try {
      const wRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1w&limit=${config.mashaMaPeriods1w}`);
      if (!wRes.ok) throw new Error(`Weekly API failed: ${wRes.status}`);
      const wKlines = (await wRes.json()) as any[];
      const ma1w = this.calculateSMA(wKlines, config.mashaMaPeriods1w);
      const weakness1w = currentPrice < ma1w * (1 - config.mashaMarginLow1w / 100);

      const hRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=${config.mashaMaPeriods1h}`);
      if (!hRes.ok) throw new Error(`Hourly API failed: ${hRes.status}`);
      const hKlines = (await hRes.json()) as any[];
      const ma1h = this.calculateSMA(hKlines, config.mashaMaPeriods1h);
      const weakness1h = currentPrice < ma1h * (1 - config.mashaMarginLow1h / 100);

      return { weakness1w, weakness1h, ma1w, ma1h };
    } catch (error) {
      this.log.warn('Masha: Weakness check failed (safety blocking):', (error as any).message);
      return { weakness1w: false, weakness1h: false, ma1w: currentPrice, ma1h: currentPrice };
    }
  }

  private calculateSMA(klines: any[], periods: number): number {
    if (!klines || klines.length < periods) return 0;
    const closes = klines.slice(-periods).map((k: any) => parseFloat(k[4]));
    return closes.reduce((acc: number, c: number) => acc + c, 0) / closes.length;
  }

  private saveState() { db.saveCustomData('masha_state', this.state); }
  private loadState() {
    const saved = db.getCustomData('masha_state');
    if (saved && Array.isArray(saved.rungs)) { this.state = saved; this.log.info(`Masha: Restored state with ${this.state.rungs.length} active rungs.`); }
  }
}
