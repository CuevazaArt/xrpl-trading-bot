import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('LouiseStrategy');

interface LouiseRung {
  price: number;
  qty: number;
  isLucky: boolean;
  timestamp: number;
}

interface LouiseState {
  epochId: string;
  rungs: LouiseRung[];
  lastPurchasePrice: number;
  sellSequence?: number;
  sellPrice?: number;
}

export class XRPLBaseLouiseStrategy implements IStrategy {
  public readonly name = 'louise';

  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  private state: LouiseState = {
    epochId: '',
    rungs: [],
    lastPurchasePrice: 0
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
      strategyName: 'Louise DCA Long'
    });

    log.info(`Louise initialized: profit_target=${config.louiseProfitTargetPct}%, dca_step=${config.louiseDcaStepPct}%, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. Sync sell order fill
    await this.syncSellOrder();

    // 2. Check Lucky Strike and regular DCA purchases
    if (this.state.rungs.length === 0) {
      // First purchase
      log.info('Louise: No active rungs. Placing initial Spot purchase...');
      await this.executeBuy(marketPrice, false);
      return;
    }

    // Positions active
    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalCost = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalCost / totalVolume;
    const profitPct = ((marketPrice - avgPrice) / avgPrice) * 100;

    log.info(`Louise status: Rungs=${this.state.rungs.length}/${config.maxRungs} | AvgPrice=${avgPrice.toFixed(4)} | PPrice=${this.state.lastPurchasePrice.toFixed(4)} | Profit=${profitPct.toFixed(2)}%`);

    // Check regular DCA Buy
    const dcaTrigger = this.state.lastPurchasePrice * (1 - config.louiseDcaStepPct / 100);
    const canDcaBuy = this.state.rungs.filter(r => !r.isLucky).length < config.maxRungs;

    if (marketPrice <= dcaTrigger && canDcaBuy) {
      log.info(`Louise DCA triggered: marketPrice(${marketPrice.toFixed(4)}) <= dcaTrigger(${dcaTrigger.toFixed(4)})`);
      await this.executeBuy(marketPrice, false);
      return;
    }

    // Check Lucky Strike (Heikin-Ashi daily low threshold check)
    const haLow = await this.fetchHeikinAshiDailyLow();
    if (haLow > 0 && marketPrice <= haLow) {
      log.info(`Louise Lucky Strike triggered! marketPrice(${marketPrice.toFixed(4)}) <= daily ha_low(${haLow.toFixed(4)})`);
      // Buy with Lucky Strike flag
      await this.executeBuy(marketPrice, true);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Louise keeping limit sell orders active in the book.');
  }

  private async syncSellOrder() {
    if (!this.state.sellSequence) return;

    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address
      });

      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      // If our consolidative TP order is no longer in account offers, it has filled
      if (!activeSequences.has(this.state.sellSequence)) {
        log.info(`Louise: Consolidated Sell Limit TP order filled! (Seq: ${this.state.sellSequence}, Price: ${this.state.sellPrice})`);
        
        db.logTransaction('LOUISE_TP_FILLED', '', 'FILLED', {
          avgPrice: (this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0) / this.state.rungs.reduce((acc, r) => acc + r.qty, 0)),
          sellPrice: this.state.sellPrice,
          totalQty: this.state.rungs.reduce((acc, r) => acc + r.qty, 0)
        });

        // Clear epoch state
        this.state = {
          epochId: '',
          rungs: [],
          lastPurchasePrice: 0
        };
        this.saveState();
      }
    } catch (error) {
      log.error('Louise: Error checking active sell offers:', error);
    }
  }

  private async executeBuy(price: number, isLucky: boolean) {
    const buyQty = parseFloat(config.rungQtyXrp);
    const maxBuyPrice = price * 1.01;
    const usdCost = (buyQty * maxBuyPrice).toFixed(4);

    const takerPays = (buyQty * 1000000).toString();
    const takerGets = {
      currency: 'USD',
      value: usdCost,
      issuer: this.usdIssuer
    };

    log.info(`Louise: Placing ${isLucky ? 'LUCKY STRIKE' : 'REGULAR'} Buy Limit (max price: ${maxBuyPrice.toFixed(4)})`);

    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!buyResult.success || !buyResult.sequence) {
        log.error('Louise: Buy order creation failed:', buyResult.error);
        return;
      }

      db.logTransaction('LOUISE_BUY', buyResult.hash || '', 'tesSUCCESS', { price, amount: buyQty, isLucky });

      // Add rung
      this.state.rungs.push({
        price,
        qty: buyQty,
        isLucky,
        timestamp: Date.now()
      });

      if (!isLucky) {
        this.state.lastPurchasePrice = price;
      }

      if (!this.state.epochId) {
        this.state.epochId = `epoch_louise_${Date.now()}`;
      }

      // Re-place or update Consolidated Sell TP order
      await this.placeConsolidatedTP();
      this.saveState();
    } catch (error) {
      log.error('Louise: Exception during purchase execution:', error);
    }
  }

  private async placeConsolidatedTP() {
    // 1. Cancel previous TP if active
    if (this.state.sellSequence) {
      log.info(`Louise: Canceling previous TP order (Seq: ${this.state.sellSequence}) to consolidate`);
      await this.orderManager.cancelOrder(this.wallet, this.state.sellSequence);
      this.state.sellSequence = undefined;
      this.state.sellPrice = undefined;
    }

    const totalVolume = this.state.rungs.reduce((acc, r) => acc + r.qty, 0);
    const totalCost = this.state.rungs.reduce((acc, r) => acc + (r.price * r.qty), 0);
    const avgPrice = totalCost / totalVolume;

    const sellPrice = parseFloat((avgPrice * (1 + config.louiseProfitTargetPct / 100)).toFixed(4));
    const totalUsdValue = (totalVolume * sellPrice).toFixed(4);

    const sellTakerPays = {
      currency: 'USD',
      value: totalUsdValue,
      issuer: this.usdIssuer
    };
    const sellTakerGets = (totalVolume * 1000000).toString();

    log.info(`Louise: Placing consolidated TP Sell order of ${totalVolume} XRP at ${sellPrice.toFixed(4)} USD`);

    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, sellTakerPays, sellTakerGets);
      if (sellResult.success && sellResult.sequence !== undefined) {
        this.state.sellSequence = sellResult.sequence;
        this.state.sellPrice = sellPrice;
        db.logTransaction('LOUISE_TP_LIMIT', sellResult.hash || '', 'tesSUCCESS', { price: sellPrice, amount: totalVolume });
      } else {
        log.error('Louise: Consolidated TP placement failed:', sellResult.error);
      }
    } catch (error) {
      log.error('Louise: Exception placing consolidated TP:', error);
    }

    this.updateDashboard(avgPrice, sellPrice || 0);
  }

  private async fetchHeikinAshiDailyLow(): Promise<number> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1d&limit=2');
      if (!res.ok) return 0;
      const klines: any[] = await res.json();
      if (!klines || klines.length < 2) return 0;

      // Candle structure: [time, open, high, low, close, ...]
      const o = parseFloat(klines[0][1]);
      const h = parseFloat(klines[0][2]);
      const l = parseFloat(klines[0][3]);
      const c = parseFloat(klines[0][4]);

      const haClose = (o + h + l + c) / 4;
      const haOpen = (parseFloat(klines[0][1]) + parseFloat(klines[0][4])) / 2; // approximation
      const haLow = Math.min(l, haOpen, haClose);

      return haLow;
    } catch {
      return 0;
    }
  }

  private saveState() {
    db.saveCustomData('louise_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('louise_state');
    if (saved && Array.isArray(saved.rungs)) {
      this.state = saved;
      log.info(`Louise: Restored state with ${this.state.rungs.length} active rungs from DB.`);
    }
  }

  private async updateDashboard(avgPrice: number, sellPrice: number) {
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
        buyTarget: this.state.lastPurchasePrice > 0 ? (this.state.lastPurchasePrice * (1 - config.louiseDcaStepPct / 100)).toString() : 'None',
        sellTarget: sellPrice.toString(),
        activeBuySeq: `Rungs: ${this.state.rungs.length}`,
        activeSellSeq: this.state.sellSequence ? `TP Seq: ${this.state.sellSequence}` : 'Ninguna',
        strategyName: 'Louise DCA Long',
        activeRungs: `${this.state.rungs.length} / ${config.maxRungs}`,
        botStatus: `Running (Avg: ${avgPrice.toFixed(4)})`
      });
    } catch (error) {
      log.error('Louise: Dashboard update failed:', error);
    }
  }
}
