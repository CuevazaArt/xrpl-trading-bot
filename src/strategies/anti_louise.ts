import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface AntiLouiseRung { price: number; qty: number; isLucky: boolean; timestamp: number; }
interface AntiLouiseState { epochId: string; rungs: AntiLouiseRung[]; lastShortPrice: number; buySequence?: number; buyPrice?: number; }

export class XRPLBaseAntiLouiseStrategy extends AbstractStrategy {
  public readonly name = 'anti_louise';
  private state: AntiLouiseState = { epochId: '', rungs: [], lastShortPrice: 0 };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Anti-Louise DCA Short' });
    this.log.info(`Anti-Louise initialized: profit_target=${config.antiLouiseProfitTargetPct}%, dca_step=${config.antiLouiseDcaStepPct}%, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    await this.syncBuyOrder();

    if (this.state.rungs.length === 0) {
      this.log.info('Anti-Louise: No active rungs. Placing initial Spot Sell (Short)...');
      await this.executeSell(marketPrice, false);
      return;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalReceived = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalReceived / totalVolume;
    const profitPct = ((totalReceived - totalVolume * marketPrice) / totalReceived) * 100;

    this.log.info(`Anti-Louise status: Rungs=${this.state.rungs.length}/${config.maxRungs} | AvgPrice=${avgPrice.toFixed(4)} | Profit=${profitPct.toFixed(2)}%`);

    const dcaTrigger = this.state.lastShortPrice * (1 + config.antiLouiseDcaStepPct / 100);
    const canDcaSell = this.state.rungs.filter(r => !r.isLucky).length < config.maxRungs;

    if (marketPrice >= dcaTrigger && canDcaSell) {
      this.log.info(`Anti-Louise DCA triggered: marketPrice(${marketPrice.toFixed(4)}) >= dcaTrigger(${dcaTrigger.toFixed(4)})`);
      await this.executeSell(marketPrice, false);
      return;
    }

    const haHigh = await this.fetchHeikinAshiDailyHigh();
    if (haHigh > 0 && marketPrice >= haHigh) {
      this.log.info(`Anti-Louise Lucky Strike triggered! marketPrice(${marketPrice.toFixed(4)}) >= daily ha_high(${haHigh.toFixed(4)})`);
      await this.executeSell(marketPrice, true);
    }
  }

  async cleanup(): Promise<void> { this.log.info('Cleanup: Anti-Louise keeping limit buy orders active.'); }

  private async syncBuyOrder() {
    if (!this.state.buySequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.buySequence)) {
        this.log.info(`Anti-Louise: Consolidated Buy Limit TP order filled! (Seq: ${this.state.buySequence})`);
        db.logTransaction('ANTI_LOUISE_TP_FILLED', '', 'FILLED', {
          avgPrice: (this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0) / this.state.rungs.reduce((acc, r) => acc + r.qty, 0)),
          buyPrice: this.state.buyPrice, totalQty: this.state.rungs.reduce((acc, r) => acc + r.qty, 0)
        });
        this.state = { epochId: '', rungs: [], lastShortPrice: 0 };
        this.saveState();
      }
    } catch (error) { this.log.error('Anti-Louise: Error checking active buy offers:', error); }
  }

  private async executeSell(price: number, isLucky: boolean) {
    const sellQty = parseFloat(config.rungQtyXrp);
    const minSellPrice = price * 0.99;
    const usdCost = (sellQty * minSellPrice).toFixed(4);
    const takerPays = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };
    const takerGets = (sellQty * 1000000).toString();

    this.log.info(`Anti-Louise: Placing ${isLucky ? 'LUCKY STRIKE' : 'REGULAR'} Sell Limit (min price: ${minSellPrice.toFixed(4)})`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!sellResult.success || !sellResult.sequence) { this.log.error('Anti-Louise: Sell failed:', sellResult.error); return; }

      db.logTransaction('ANTI_LOUISE_SELL', sellResult.hash || '', 'tesSUCCESS', { price, amount: sellQty, isLucky });
      this.state.rungs.push({ price, qty: sellQty, isLucky, timestamp: Date.now() });
      if (!isLucky) this.state.lastShortPrice = price;
      if (!this.state.epochId) this.state.epochId = `epoch_antilouise_${Date.now()}`;

      await this.placeConsolidatedTP();
      this.saveState();
    } catch (error) { this.log.error('Anti-Louise: Exception during sell:', error); }
  }

  private async placeConsolidatedTP() {
    if (this.state.buySequence) {
      this.log.info(`Anti-Louise: Canceling previous TP order (Seq: ${this.state.buySequence})`);
      await this.orderManager.cancelOrder(this.wallet, this.state.buySequence);
      this.state.buySequence = undefined; this.state.buyPrice = undefined;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalReceived = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalReceived / totalVolume;
    const buyPrice = parseFloat((avgPrice * (1 - config.antiLouiseProfitTargetPct / 100)).toFixed(4));
    const totalUsdCost = (totalVolume * buyPrice).toFixed(4);

    const buyTakerPays = (totalVolume * 1000000).toString();
    const buyTakerGets = { currency: 'USD', value: totalUsdCost, issuer: this.usdIssuer };

    this.log.info(`Anti-Louise: Placing consolidated TP Buy order of ${totalVolume} XRP at ${buyPrice.toFixed(4)} USD`);
    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, buyTakerPays, buyTakerGets);
      if (buyResult.success && buyResult.sequence !== undefined) {
        this.state.buySequence = buyResult.sequence; this.state.buyPrice = buyPrice;
        db.logTransaction('ANTI_LOUISE_TP_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: buyPrice, amount: totalVolume });
      } else { this.log.error('Anti-Louise: Consolidated TP placement failed:', buyResult.error); }
    } catch (error) { this.log.error('Anti-Louise: Exception placing consolidated TP:', error); }

    await this.updateDashboardWithBalances({
      midPrice: avgPrice.toString(), buyTarget: (buyPrice || 0).toString(),
      sellTarget: this.state.lastShortPrice > 0 ? (this.state.lastShortPrice * (1 + config.antiLouiseDcaStepPct / 100)).toString() : 'None',
      activeBuySeq: this.state.buySequence ? `TP Seq: ${this.state.buySequence}` : 'Ninguna',
      activeSellSeq: `Rungs: ${this.state.rungs.length}`,
      strategyName: 'Anti-Louise DCA Short', activeRungs: `${this.state.rungs.length} / ${config.maxRungs}`,
      botStatus: `Running (Avg: ${avgPrice.toFixed(4)})`
    });
  }

  private async fetchHeikinAshiDailyHigh(): Promise<number> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1d&limit=2');
      if (!res.ok) return 0;
      const klines = (await res.json()) as any[];
      if (!klines || klines.length < 2) return 0;
      const o = parseFloat(klines[0][1]), h = parseFloat(klines[0][2]), l = parseFloat(klines[0][3]), c = parseFloat(klines[0][4]);
      const haClose = (o + h + l + c) / 4;
      const haOpen = (o + c) / 2;
      return Math.max(h, haOpen, haClose);
    } catch { return 0; }
  }

  private saveState() { db.saveCustomData('anti_louise_state', this.state); }
  private loadState() {
    const saved = db.getCustomData('anti_louise_state');
    if (saved && Array.isArray(saved.rungs)) { this.state = saved; this.log.info(`Anti-Louise: Restored state with ${this.state.rungs.length} active rungs.`); }
  }
}
