import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('AgarthaStrategy');

interface AgarthaState {
  epochId: string;
  positionSize: number; // Qty of XRP held
  entryPrice: number;
  peakPrice: number;
  isTrailingActive: boolean;
  buySequence?: number;
  buyLimitPrice?: number;
  ledgersInPosition: number;
}

export class XRPLAgarthaStrategy implements IStrategy {
  public readonly name = 'agartha';

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
      strategyName: 'Agartha Moonshot Trailing'
    });

    log.info(`Agartha initialized: trailing_stop=${config.agarthaTrailingStopPct}%, activation_profit=${config.agarthaActivationProfitPct}%, offset=${config.agarthaEntryLimitOffsetPct}%`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. If we have a pending buy limit order, check if it got filled
    await this.syncBuyLimitOrder(marketPrice);

    // 2. If no position is active, evaluate initial Entry-Limit placement
    if (this.state.positionSize === 0 && !this.state.buySequence) {
      log.info('Agartha: No active position or order. Executing initial entry...');
      await this.placeEntry(marketPrice);
      return;
    }

    // 3. If we are in position, calculate trailing exit and time stops
    if (this.state.positionSize > 0) {
      this.state.ledgersInPosition++;
      
      // Time Stop
      if (this.state.ledgersInPosition >= config.agarthaMaxHoldingLedgers) {
        log.warn(`Agartha Time Stop: position held for ${this.state.ledgersInPosition} ledgers. Liquidating...`);
        await this.liquidatePosition(marketPrice, 'TIME_STOP');
        return;
      }

      // Update Peak Price
      this.state.peakPrice = Math.max(this.state.peakPrice, marketPrice);

      // Evaluate Activation
      if (!this.state.isTrailingActive) {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        if (this.state.peakPrice >= activationThreshold) {
          this.state.isTrailingActive = true;
          log.warn(`¡Agartha Trailing Stop ACTIVATED! PeakPrice(${this.state.peakPrice.toFixed(4)}) >= Threshold(${activationThreshold.toFixed(4)})`);
        }
      }

      // Evaluate Exit
      if (this.state.isTrailingActive) {
        const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
        const distanceToFloorPct = ((marketPrice - trailingFloor) / marketPrice) * 100;
        
        log.info(`Agartha Trailing: Peak=${this.state.peakPrice.toFixed(4)} | Floor=${trailingFloor.toFixed(4)} | Price=${marketPrice.toFixed(4)} | Dist=${distanceToFloorPct.toFixed(2)}%`);

        if (marketPrice <= trailingFloor) {
          log.warn(`¡Agartha Trailing Triggered! marketPrice(${marketPrice.toFixed(4)}) <= Floor(${trailingFloor.toFixed(4)}). Liquidating moonshot...`);
          await this.liquidatePosition(marketPrice, 'TRAILING_EXIT');
          return;
        }
      } else {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        log.info(`Agartha Position: Entry=${this.state.entryPrice.toFixed(4)} | Peak=${this.state.peakPrice.toFixed(4)} | TargetActivation=${activationThreshold.toFixed(4)} | Price=${marketPrice.toFixed(4)}`);
      }

      this.saveState();
      this.updateDashboard(marketPrice);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Agartha keeping active stop limit structures.');
  }

  private async syncBuyLimitOrder(marketPrice: number) {
    if (!this.state.buySequence) return;

    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address
      });

      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      // If the Entry-Limit order is no longer in account offers, it has filled
      if (!activeSequences.has(this.state.buySequence)) {
        const fillPrice = this.state.buyLimitPrice || marketPrice;
        log.info(`Agartha: Entry-Limit filled! (Seq: ${this.state.buySequence}, Price: ${fillPrice})`);

        this.state.positionSize = parseFloat(config.rungQtyXrp);
        this.state.entryPrice = fillPrice;
        this.state.peakPrice = fillPrice;
        this.state.isTrailingActive = false;
        this.state.buySequence = undefined;
        this.state.buyLimitPrice = undefined;
        this.state.ledgersInPosition = 0;
        this.state.epochId = `epoch_agartha_${Date.now()}`;

        db.logTransaction('AGARTHA_LIMIT_FILLED', '', 'FILLED', {
          entryPrice: fillPrice,
          qty: this.state.positionSize
        });

        this.saveState();
      }
    } catch (error) {
      log.error('Agartha: Error checking active buy offers:', error);
    }
  }

  private async placeEntry(marketPrice: number) {
    const buyQty = parseFloat(config.rungQtyXrp);

    if (config.agarthaEntryLimitOffsetPct === 0) {
      // Immediate market buy (simulated)
      const maxBuyPrice = marketPrice * 1.01;
      const usdCost = (buyQty * maxBuyPrice).toFixed(4);

      const takerPays = (buyQty * 1000000).toString();
      const takerGets = {
        currency: 'USD',
        value: usdCost,
        issuer: this.usdIssuer
      };

      log.info(`Agartha: Executing immediate Spot Buy (Limit price: ${maxBuyPrice.toFixed(4)})`);
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
          this.updateDashboard(marketPrice);
        }
      } catch (error) {
        log.error('Agartha: Failed to buy market:', error);
      }
    } else {
      // Entry-Limit order placed below the market price
      const limitPrice = parseFloat((marketPrice * (1 - config.agarthaEntryLimitOffsetPct / 100)).toFixed(4));
      const usdCost = (buyQty * limitPrice).toFixed(4);

      const takerPays = (buyQty * 1000000).toString();
      const takerGets = {
        currency: 'USD',
        value: usdCost,
        issuer: this.usdIssuer
      };

      log.info(`Agartha: Placing Entry-Limit order of ${buyQty} XRP at ${limitPrice.toFixed(4)} USD`);
      try {
        const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        if (buyResult.success && buyResult.sequence !== undefined) {
          this.state.buySequence = buyResult.sequence;
          this.state.buyLimitPrice = limitPrice;
          this.saveState();

          db.logTransaction('AGARTHA_ENTRY_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: limitPrice, amount: buyQty });
        } else {
          log.error('Agartha: Failed to place Entry-Limit order:', buyResult.error);
        }
      } catch (error) {
        log.error('Agartha: Exception placing Entry-Limit:', error);
      }
    }
  }

  private async liquidatePosition(currentPrice: number, reason: string) {
    const qty = this.state.positionSize;
    // Spot Sell order (agressively priced at -1% to fill immediately)
    const minSellPrice = currentPrice * 0.99;
    const usdCost = (qty * minSellPrice).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdCost,
      issuer: this.usdIssuer
    };
    const takerGets = (qty * 1000000).toString(); // drops

    log.warn(`Agartha: Liquidating position of ${qty} XRP at current price ${currentPrice.toFixed(4)} USD (${reason})`);

    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (sellResult.success) {
        db.logTransaction('AGARTHA_LIQUIDATED', sellResult.hash || '', 'tesSUCCESS', {
          reason,
          entryPrice: this.state.entryPrice,
          exitPrice: currentPrice,
          qty,
          profitUsdt: qty * (currentPrice - this.state.entryPrice)
        });

        // Reset state
        this.state = {
          epochId: '',
          positionSize: 0,
          entryPrice: 0,
          peakPrice: 0,
          isTrailingActive: false,
          ledgersInPosition: 0
        };
        this.saveState();
      } else {
        log.error('Agartha: Failed to execute liquidation order:', sellResult.error);
      }
    } catch (error) {
      log.error('Agartha: Exception during liquidation:', error);
    }
  }

  private saveState() {
    db.saveCustomData('agartha_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('agartha_state');
    if (saved && saved.epochId !== undefined) {
      this.state = saved;
      log.info(`Agartha: Restored state from DB (Position: ${this.state.positionSize} XRP, Trailing: ${this.state.isTrailingActive}).`);
    }
  }

  private async updateDashboard(marketPrice: number) {
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

      const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: marketPrice.toString(),
        buyTarget: this.state.buySequence ? `Limit: ${this.state.buyLimitPrice}` : 'None',
        sellTarget: this.state.isTrailingActive ? trailingFloor.toFixed(4) : 'Trailing Inactive',
        activeBuySeq: this.state.buySequence ? `Buy Seq: ${this.state.buySequence}` : 'Ninguna',
        activeSellSeq: this.state.positionSize > 0 ? `Peak: ${this.state.peakPrice.toFixed(4)}` : 'Ninguna',
        strategyName: 'Agartha Moonshot',
        activeRungs: this.state.positionSize > 0 ? '1 / 1' : '0 / 1',
        botStatus: this.state.positionSize > 0 ? `In Position (${this.state.isTrailingActive ? 'Trailing active' : 'Tracking activation'})` : 'Waiting for entry'
      });
    } catch (error) {
      log.error('Agartha: Dashboard update failed:', error);
    }
  }
}
