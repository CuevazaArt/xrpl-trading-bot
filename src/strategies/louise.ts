import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface LouiseRung { price: number; qty: number; isLucky: boolean; timestamp: number; }
interface LouiseState { epochId: string; rungs: LouiseRung[]; lastPurchasePrice: number; sellSequence?: number; sellPrice?: number; }

export class XRPLBaseLouiseStrategy extends AbstractStrategy {
  public readonly name = 'louise';
  private state: LouiseState = { epochId: '', rungs: [], lastPurchasePrice: 0 };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Louise DCA Long' });
    this.log.info(`Louise initialized: profit_target=${config.louiseProfitTargetPct}%, dca_step=${config.louiseDcaStepPct}%, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    await this.syncSellOrder();

    if (this.state.rungs.length === 0) {
      this.log.info('Louise: No active rungs. Placing initial Spot purchase...');
      await this.executeBuy(marketPrice, false);
      return;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalCost = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalCost / totalVolume;
    const profitPct = ((marketPrice - avgPrice) / avgPrice) * 100;

    this.log.info(`Louise status: Rungs=${this.state.rungs.length}/${config.maxRungs} | AvgPrice=${avgPrice.toFixed(4)} | Profit=${profitPct.toFixed(2)}%`);

    const dcaTrigger = this.state.lastPurchasePrice * (1 - config.louiseDcaStepPct / 100);
    const canDcaBuy = this.state.rungs.filter(r => !r.isLucky).length < config.maxRungs;

    if (marketPrice <= dcaTrigger && canDcaBuy) {
      this.log.info(`Louise DCA triggered: marketPrice(${marketPrice.toFixed(4)}) <= dcaTrigger(${dcaTrigger.toFixed(4)})`);
      await this.executeBuy(marketPrice, false);
      return;
    }

    const haLow = await this.fetchHeikinAshiDailyLow();
    if (haLow > 0 && marketPrice <= haLow) {
      this.log.info(`Louise Lucky Strike triggered! marketPrice(${marketPrice.toFixed(4)}) <= daily ha_low(${haLow.toFixed(4)})`);
      await this.executeBuy(marketPrice, true);
    }
  }

  async cleanup(): Promise<void> { this.log.info('Cleanup: Louise keeping limit sell orders active.'); }

  private async syncSellOrder() {
    if (!this.state.sellSequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.sellSequence)) {
        this.log.info(`Louise: Consolidated Sell Limit TP order filled! (Seq: ${this.state.sellSequence})`);
        db.logTransaction('LOUISE_TP_FILLED', '', 'FILLED', {
          avgPrice: (this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0) / this.state.rungs.reduce((acc, r) => acc + r.qty, 0)),
          sellPrice: this.state.sellPrice, totalQty: this.state.rungs.reduce((acc, r) => acc + r.qty, 0)
        });
        this.state = { epochId: '', rungs: [], lastPurchasePrice: 0 };
        this.saveState();
      }
    } catch (error) { this.log.error('Louise: Error checking active sell offers:', error); }
  }

  private async executeBuy(price: number, isLucky: boolean) {
    const buyQty = parseFloat(config.rungQtyXrp);
    const maxBuyPrice = price * 1.01;
    const usdCost = (buyQty * maxBuyPrice).toFixed(4);
    const takerPays = (buyQty * 1000000).toString();
    const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

    this.log.info(`Louise: Placing ${isLucky ? 'LUCKY STRIKE' : 'REGULAR'} Buy Limit (max price: ${maxBuyPrice.toFixed(4)})`);
    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!buyResult.success || !buyResult.sequence) { this.log.error('Louise: Buy order creation failed:', buyResult.error); return; }

      db.logTransaction('LOUISE_BUY', buyResult.hash || '', 'tesSUCCESS', { price, amount: buyQty, isLucky });
      this.state.rungs.push({ price, qty: buyQty, isLucky, timestamp: Date.now() });
      if (!isLucky) this.state.lastPurchasePrice = price;
      if (!this.state.epochId) this.state.epochId = `epoch_louise_${Date.now()}`;

      await this.placeConsolidatedTP();
      this.saveState();
    } catch (error) { this.log.error('Louise: Exception during purchase:', error); }
  }

  private async placeConsolidatedTP() {
    if (this.state.sellSequence) {
      this.log.info(`Louise: Canceling previous TP order (Seq: ${this.state.sellSequence})`);
      await this.orderManager.cancelOrder(this.wallet, this.state.sellSequence);
      this.state.sellSequence = undefined; this.state.sellPrice = undefined;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalCost = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalCost / totalVolume;
    const sellPrice = parseFloat((avgPrice * (1 + config.louiseProfitTargetPct / 100)).toFixed(4));
    const totalUsdValue = (totalVolume * sellPrice).toFixed(4);

    const sellTakerPays = { currency: 'USD', value: totalUsdValue, issuer: this.usdIssuer };
    const sellTakerGets = (totalVolume * 1000000).toString();

    this.log.info(`Louise: Placing consolidated TP Sell order of ${totalVolume} XRP at ${sellPrice.toFixed(4)} USD`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, sellTakerPays, sellTakerGets);
      if (sellResult.success && sellResult.sequence !== undefined) {
        this.state.sellSequence = sellResult.sequence; this.state.sellPrice = sellPrice;
        db.logTransaction('LOUISE_TP_LIMIT', sellResult.hash || '', 'tesSUCCESS', { price: sellPrice, amount: totalVolume });
      } else { this.log.error('Louise: Consolidated TP placement failed:', sellResult.error); }
    } catch (error) { this.log.error('Louise: Exception placing consolidated TP:', error); }

    await this.updateDashboardWithBalances({
      midPrice: avgPrice.toString(),
      buyTarget: this.state.lastPurchasePrice > 0 ? (this.state.lastPurchasePrice * (1 - config.louiseDcaStepPct / 100)).toString() : 'None',
      sellTarget: (sellPrice || 0).toString(),
      activeBuySeq: `Rungs: ${this.state.rungs.length}`,
      activeSellSeq: this.state.sellSequence ? `TP Seq: ${this.state.sellSequence}` : 'Ninguna',
      strategyName: 'Louise DCA Long', activeRungs: `${this.state.rungs.length} / ${config.maxRungs}`,
      botStatus: `Running (Avg: ${avgPrice.toFixed(4)})`
    });
  }

  private async fetchHeikinAshiDailyLow(): Promise<number> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1d&limit=2');
      if (!res.ok) return 0;
      const klines = (await res.json()) as any[];
      if (!klines || klines.length < 2) return 0;
      const o = parseFloat(klines[0][1]), h = parseFloat(klines[0][2]), l = parseFloat(klines[0][3]), c = parseFloat(klines[0][4]);
      const haClose = (o + h + l + c) / 4;
      const haOpen = (o + c) / 2;
      return Math.min(l, haOpen, haClose);
    } catch { return 0; }
  }

  private saveState() { db.saveCustomData('louise_state', this.state); }
  private loadState() {
    const saved = db.getCustomData('louise_state');
    if (saved && Array.isArray(saved.rungs)) { this.state = saved; this.log.info(`Louise: Restored state with ${this.state.rungs.length} active rungs.`); }
  }
}
