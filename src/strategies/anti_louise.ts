import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('AntiLouiseStrategy');

interface AntiLouiseRung {
  price: number;
  qty: number;
  isLucky: boolean;
  timestamp: number;
}

interface AntiLouiseState {
  epochId: string;
  rungs: AntiLouiseRung[];
  lastShortPrice: number;
  buySequence?: number;
  buyPrice?: number;
}

export class XRPLBaseAntiLouiseStrategy implements IStrategy {
  public readonly name = 'anti_louise';

  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  private state: AntiLouiseState = {
    epochId: '',
    rungs: [],
    lastShortPrice: 0
  };

  private usdIssuer = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

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

    this.loadState();

    this.dashboard.updateState({
      walletAddress: wallet.address,
      strategyName: 'Anti-Louise DCA Short'
    });

    log.info(`Anti-Louise initialized: profit_target=${config.antiLouiseProfitTargetPct}%, dca_step=${config.antiLouiseDcaStepPct}%, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. Sync buy order fill (Take Profit)
    await this.syncBuyOrder();

    // 2. Check Lucky Strike and regular DCA shorts (Spot Sell)
    if (this.state.rungs.length === 0) {
      log.info('Anti-Louise: No active rungs. Placing initial Spot Sell (Short)...');
      await this.executeSell(marketPrice, false);
      return;
    }

    // Positions active
    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalReceived = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalReceived / totalVolume;
    
    // Profit for short is positive when market price falls below avgPrice
    const currentExposure = totalVolume * marketPrice;
    const profitUsdt = totalReceived - currentExposure;
    const profitPct = (profitUsdt / totalReceived) * 100;

    log.info(`Anti-Louise status: Rungs=${this.state.rungs.length}/${config.maxRungs} | AvgPrice=${avgPrice.toFixed(4)} | PPrice=${this.state.lastShortPrice.toFixed(4)} | Profit=${profitPct.toFixed(2)}%`);

    // Check regular DCA Sell (Short Open)
    const dcaTrigger = this.state.lastShortPrice * (1 + config.antiLouiseDcaStepPct / 100);
    const canDcaSell = this.state.rungs.filter(r => !r.isLucky).length < config.maxRungs;

    if (marketPrice >= dcaTrigger && canDcaSell) {
      log.info(`Anti-Louise DCA triggered: marketPrice(${marketPrice.toFixed(4)}) >= dcaTrigger(${dcaTrigger.toFixed(4)})`);
      await this.executeSell(marketPrice, false);
      return;
    }

    // Check Lucky Strike (Heikin-Ashi daily high threshold check)
    const haHigh = await this.fetchHeikinAshiDailyHigh();
    if (haHigh > 0 && marketPrice >= haHigh) {
      log.info(`Anti-Louise Lucky Strike triggered! marketPrice(${marketPrice.toFixed(4)}) >= daily ha_high(${haHigh.toFixed(4)})`);
      await this.executeSell(marketPrice, true);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Anti-Louise keeping limit buy orders active in the book.');
  }

  private async syncBuyOrder() {
    if (!this.state.buySequence) return;

    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address
      });

      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      // If our consolidative TP order is no longer in account offers, it has filled
      if (!activeSequences.has(this.state.buySequence)) {
        log.info(`Anti-Louise: Consolidated Buy Limit TP order filled! (Seq: ${this.state.buySequence}, Price: ${this.state.buyPrice})`);
        
        db.logTransaction('ANTI_LOUISE_TP_FILLED', '', 'FILLED', {
          avgPrice: (this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0) / this.state.rungs.reduce((acc, r) => acc + r.qty, 0)),
          buyPrice: this.state.buyPrice,
          totalQty: this.state.rungs.reduce((acc, r) => acc + r.qty, 0)
        });

        // Clear epoch state
        this.state = {
          epochId: '',
          rungs: [],
          lastShortPrice: 0
        };
        this.saveState();
      }
    } catch (error) {
      log.error('Anti-Louise: Error checking active buy offers:', error);
    }
  }

  private async executeSell(price: number, isLucky: boolean) {
    const sellQty = parseFloat(config.rungQtyXrp);
    
    // Simular venta a mercado: ofertamos vender XRP pidiendo un 1% menos de USD para asegurar llenado inmediato
    const minSellPrice = price * 0.99;
    const usdCost = (sellQty * minSellPrice).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdCost,
      issuer: this.usdIssuer
    };
    const takerGets = (sellQty * 1000000).toString(); // XRP en drops

    log.info(`Anti-Louise: Placing ${isLucky ? 'LUCKY STRIKE' : 'REGULAR'} Sell Limit (min price: ${minSellPrice.toFixed(4)})`);

    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!sellResult.success || !sellResult.sequence) {
        log.error('Anti-Louise: Sell order creation failed:', sellResult.error);
        return;
      }

      db.logTransaction('ANTI_LOUISE_SELL', sellResult.hash || '', 'tesSUCCESS', { price, amount: sellQty, isLucky });

      // Add rung
      this.state.rungs.push({
        price,
        qty: sellQty,
        isLucky,
        timestamp: Date.now()
      });

      if (!isLucky) {
        this.state.lastShortPrice = price;
      }

      if (!this.state.epochId) {
        this.state.epochId = `epoch_antilouise_${Date.now()}`;
      }

      // Re-place or update Consolidated Buy TP order
      await this.placeConsolidatedTP();
      this.saveState();
    } catch (error) {
      log.error('Anti-Louise: Exception during sell execution:', error);
    }
  }

  private async placeConsolidatedTP() {
    // 1. Cancel previous TP if active
    if (this.state.buySequence) {
      log.info(`Anti-Louise: Canceling previous TP order (Seq: ${this.state.buySequence}) to consolidate`);
      await this.orderManager.cancelOrder(this.wallet, this.state.buySequence);
      this.state.buySequence = undefined;
      this.state.buyPrice = undefined;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalReceived = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalReceived / totalVolume;

    const buyPrice = parseFloat((avgPrice * (1 - config.antiLouiseProfitTargetPct / 100)).toFixed(4));
    const totalUsdCost = (totalVolume * buyPrice).toFixed(4);

    const buyTakerPays = (totalVolume * 1000000).toString(); // XRP en drops
    const buyTakerGets = {
      currency: 'USD',
      value: totalUsdCost,
      issuer: this.usdIssuer
    };

    log.info(`Anti-Louise: Placing consolidated TP Buy order of ${totalVolume} XRP at ${buyPrice.toFixed(4)} USD`);

    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, buyTakerPays, buyTakerGets);
      if (buyResult.success && buyResult.sequence !== undefined) {
        this.state.buySequence = buyResult.sequence;
        this.state.buyPrice = buyPrice;
        db.logTransaction('ANTI_LOUISE_TP_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: buyPrice, amount: totalVolume });
      } else {
        log.error('Anti-Louise: Consolidated TP placement failed:', buyResult.error);
      }
    } catch (error) {
      log.error('Anti-Louise: Exception placing consolidated TP:', error);
    }

    this.updateDashboard(avgPrice, buyPrice || 0);
  }

  private async fetchHeikinAshiDailyHigh(): Promise<number> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1d&limit=2');
      if (!res.ok) return 0;
      const klines: any[] = await res.json();
      if (!klines || klines.length < 2) return 0;

      const o = parseFloat(klines[0][1]);
      const h = parseFloat(klines[0][2]);
      const l = parseFloat(klines[0][3]);
      const c = parseFloat(klines[0][4]);

      const haClose = (o + h + l + c) / 4;
      const haOpen = (parseFloat(klines[0][1]) + parseFloat(klines[0][4])) / 2; // approximation
      const haHigh = Math.max(h, haOpen, haClose);

      return haHigh;
    } catch {
      return 0;
    }
  }

  private saveState() {
    db.saveCustomData('anti_louise_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('anti_louise_state');
    if (saved && Array.isArray(saved.rungs)) {
      this.state = saved;
      log.info(`Anti-Louise: Restored state with ${this.state.rungs.length} active rungs from DB.`);
    }
  }

  private async updateDashboard(avgPrice: number, buyPrice: number) {
    try {
      const xrpBalanceRaw = await this.client.getXrpBalance(this.wallet.address);
      const xrpBalance = String(xrpBalanceRaw);

      let usdBalance = '0';
      const linesResponse = await this.client.request({
        command: 'account_lines',
        account: this.wallet.address
      });
      const usdLine = linesResponse.result.lines.find((line: any) => line.currency === 'USD' && line.account === this.usdIssuer);
      if (usdLine) {
        usdBalance = usdLine.balance;
      }

      db.logBalance(xrpBalance, usdBalance);

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: avgPrice.toString(),
        buyTarget: buyPrice.toString(),
        sellTarget: this.state.lastShortPrice > 0 ? (this.state.lastShortPrice * (1 + config.antiLouiseDcaStepPct / 100)).toString() : 'None',
        activeBuySeq: this.state.buySequence ? `TP Seq: ${this.state.buySequence}` : 'Ninguna',
        activeSellSeq: `Rungs: ${this.state.rungs.length}`,
        strategyName: 'Anti-Louise DCA Short',
        activeRungs: `${this.state.rungs.length} / ${config.maxRungs}`,
        botStatus: `Running (Avg: ${avgPrice.toFixed(4)})`
      });
    } catch (error) {
      log.error('Anti-Louise: Dashboard update failed:', error);
    }
  }
}
