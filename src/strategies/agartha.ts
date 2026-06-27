import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface AgarthaState {
  epochId: string;
  positionSize: number;
  entryPrice: number;
  peakPrice: number;
  isTrailingActive: boolean;
  buySequence?: number;
  buyLimitPrice?: number;
  ledgersInPosition: number;
}

export class XRPLAgarthaStrategy extends AbstractStrategy {
  public readonly name = 'agartha';
  private state: AgarthaState = { epochId: '', positionSize: 0, entryPrice: 0, peakPrice: 0, isTrailingActive: false, ledgersInPosition: 0 };

<<<<<<< Updated upstream
  protected async onInit(): Promise<void> {
=======
  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  private state: AgarthaState = {
    epochId: '',
    positionSize: 0,
    entryPrice: 0,
    peakPrice: 0,
    isTrailingActive: false,
    ledgersInPosition: 0
  };

  private usdIssuer = config.usdIssuer;

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

>>>>>>> Stashed changes
    this.loadState();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Agartha Moonshot Trailing' });
    this.log.info(`Agartha initialized: trailing_stop=${config.agarthaTrailingStopPct}%, activation_profit=${config.agarthaActivationProfitPct}%, offset=${config.agarthaEntryLimitOffsetPct}%`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    await this.syncBuyLimitOrder(marketPrice);

    if (this.state.positionSize === 0 && !this.state.buySequence) {
      this.log.info('Agartha: No active position or order. Executing initial entry...');
      await this.placeEntry(marketPrice);
      return;
    }

    if (this.state.positionSize > 0) {
      this.state.ledgersInPosition++;

      // Time Stop
      if (this.state.ledgersInPosition >= config.agarthaMaxHoldingLedgers) {
        this.log.warn(`Agartha Time Stop: position held for ${this.state.ledgersInPosition} ledgers. Liquidating...`);
        await this.liquidatePosition(marketPrice, 'TIME_STOP');
        return;
      }

      this.state.peakPrice = Math.max(this.state.peakPrice, marketPrice);

      // Activation check
      if (!this.state.isTrailingActive) {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        if (this.state.peakPrice >= activationThreshold) {
          this.state.isTrailingActive = true;
          this.log.warn(`¡Agartha Trailing Stop ACTIVATED! PeakPrice(${this.state.peakPrice.toFixed(4)}) >= Threshold(${activationThreshold.toFixed(4)})`);
        }
      }

      // Exit check
      if (this.state.isTrailingActive) {
        const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
        const distanceToFloorPct = ((marketPrice - trailingFloor) / marketPrice) * 100;
        this.log.info(`Agartha Trailing: Peak=${this.state.peakPrice.toFixed(4)} | Floor=${trailingFloor.toFixed(4)} | Price=${marketPrice.toFixed(4)} | Dist=${distanceToFloorPct.toFixed(2)}%`);

        if (marketPrice <= trailingFloor) {
          this.log.warn(`¡Agartha Trailing Triggered! Liquidating moonshot...`);
          await this.liquidatePosition(marketPrice, 'TRAILING_EXIT');
          return;
        }
      } else {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        this.log.info(`Agartha Position: Entry=${this.state.entryPrice.toFixed(4)} | Peak=${this.state.peakPrice.toFixed(4)} | TargetActivation=${activationThreshold.toFixed(4)}`);
      }

      this.saveState();
      await this.updateAgarthaDashboard(marketPrice);
    }
  }

  async cleanup(): Promise<void> { this.log.info('Cleanup: Agartha keeping active stop limit structures.'); }

  private async syncBuyLimitOrder(marketPrice: number) {
    if (!this.state.buySequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.buySequence)) {
        const fillPrice = this.state.buyLimitPrice || marketPrice;
        this.log.info(`Agartha: Entry-Limit filled! (Seq: ${this.state.buySequence}, Price: ${fillPrice})`);
        this.state.positionSize = parseFloat(config.rungQtyXrp);
        this.state.entryPrice = fillPrice;
        this.state.peakPrice = fillPrice;
        this.state.isTrailingActive = false;
        this.state.buySequence = undefined;
        this.state.buyLimitPrice = undefined;
        this.state.ledgersInPosition = 0;
        this.state.epochId = `epoch_agartha_${Date.now()}`;
        db.logTransaction('AGARTHA_LIMIT_FILLED', '', 'FILLED', { entryPrice: fillPrice, qty: this.state.positionSize });
        this.saveState();
      }
    } catch (error) { this.log.error('Agartha: Error checking active buy offers:', error); }
  }

  private async placeEntry(marketPrice: number) {
    const buyQty = parseFloat(config.rungQtyXrp);

    if (config.agarthaEntryLimitOffsetPct === 0) {
      const maxBuyPrice = marketPrice * 1.01;
      const usdCost = (buyQty * maxBuyPrice).toFixed(4);
      const takerPays = (buyQty * 1000000).toString();
      const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

      this.log.info(`Agartha: Executing immediate Spot Buy (Limit price: ${maxBuyPrice.toFixed(4)})`);
      try {
        const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        if (buyResult.success && buyResult.sequence) {
          this.state.positionSize = buyQty;
          this.state.entryPrice = marketPrice;
          this.state.peakPrice = marketPrice;
          this.state.isTrailingActive = false;
          this.state.ledgersInPosition = 0;
          this.state.epochId = `epoch_agartha_${Date.now()}`;
          this.saveState();
          db.logTransaction('AGARTHA_BUY', buyResult.hash || '', 'tesSUCCESS', { price: marketPrice, amount: buyQty });
          await this.updateAgarthaDashboard(marketPrice);
        }
      } catch (error) { this.log.error('Agartha: Failed to buy market:', error); }
    } else {
      const limitPrice = parseFloat((marketPrice * (1 - config.agarthaEntryLimitOffsetPct / 100)).toFixed(4));
      const usdCost = (buyQty * limitPrice).toFixed(4);
      const takerPays = (buyQty * 1000000).toString();
      const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

      this.log.info(`Agartha: Placing Entry-Limit order of ${buyQty} XRP at ${limitPrice.toFixed(4)} USD`);
      try {
        const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        if (buyResult.success && buyResult.sequence !== undefined) {
          this.state.buySequence = buyResult.sequence;
          this.state.buyLimitPrice = limitPrice;
          this.saveState();
          db.logTransaction('AGARTHA_ENTRY_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: limitPrice, amount: buyQty });
        } else { this.log.error('Agartha: Failed to place Entry-Limit order:', buyResult.error); }
      } catch (error) { this.log.error('Agartha: Exception placing Entry-Limit:', error); }
    }
  }

  private async liquidatePosition(currentPrice: number, reason: string) {
    const qty = this.state.positionSize;
    const minSellPrice = currentPrice * 0.99;
    const usdCost = (qty * minSellPrice).toFixed(4);
    const takerPays = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };
    const takerGets = (qty * 1000000).toString();

    this.log.warn(`Agartha: Liquidating position of ${qty} XRP at ${currentPrice.toFixed(4)} USD (${reason})`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (sellResult.success) {
        db.logTransaction('AGARTHA_LIQUIDATED', sellResult.hash || '', 'tesSUCCESS', {
          reason, entryPrice: this.state.entryPrice, exitPrice: currentPrice, qty,
          profitUsdt: qty * (currentPrice - this.state.entryPrice)
        });
        this.state = { epochId: '', positionSize: 0, entryPrice: 0, peakPrice: 0, isTrailingActive: false, ledgersInPosition: 0 };
        this.saveState();
      } else { this.log.error('Agartha: Failed to execute liquidation:', sellResult.error); }
    } catch (error) { this.log.error('Agartha: Exception during liquidation:', error); }
  }

  private saveState() { db.saveCustomData('agartha_state', this.state); }
  private loadState() {
    const saved = db.getCustomData('agartha_state');
    if (saved && saved.epochId !== undefined) { this.state = saved; this.log.info(`Agartha: Restored state (Position: ${this.state.positionSize} XRP, Trailing: ${this.state.isTrailingActive}).`); }
  }

  private async updateAgarthaDashboard(marketPrice: number) {
    const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
    await this.updateDashboardWithBalances({
      midPrice: marketPrice.toString(),
      buyTarget: this.state.buySequence ? `Limit: ${this.state.buyLimitPrice}` : 'None',
      sellTarget: this.state.isTrailingActive ? trailingFloor.toFixed(4) : 'Trailing Inactive',
      activeBuySeq: this.state.buySequence ? `Buy Seq: ${this.state.buySequence}` : 'Ninguna',
      activeSellSeq: this.state.positionSize > 0 ? `Peak: ${this.state.peakPrice.toFixed(4)}` : 'Ninguna',
      strategyName: 'Agartha Moonshot', activeRungs: this.state.positionSize > 0 ? '1 / 1' : '0 / 1',
      botStatus: this.state.positionSize > 0 ? `In Position (${this.state.isTrailingActive ? 'Trailing active' : 'Tracking activation'})` : 'Waiting for entry'
    });
  }
}
