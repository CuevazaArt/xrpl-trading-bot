import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('ThusneldaStrategy');

interface TokenPosition {
  symbol: string; // e.g. "ADA"
  avgBuyPrice: number;
  accumulatedQty: number;
  totalCost: number;
}

interface ThusneldaState {
  positions: Record<string, TokenPosition>;
}

export class XRPLThusneldaStrategy implements IStrategy {
  public readonly name = 'thusnelda';

  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  private state: ThusneldaState = {
    positions: {}
  };

  private usdIssuer = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
  private symbols: string[] = [];
  private currentSymbolIndex = 0;

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

    this.symbols = config.thusneldaSymbolsCsv.split(',').map(s => s.trim().toUpperCase());
    this.loadState();

    this.dashboard.updateState({
      walletAddress: wallet.address,
      strategyName: 'Thusnelda Basket DCA'
    });

    log.info(`Thusnelda initialized: symbols=[${this.symbols.join(', ')}], factor_mult=${config.thusneldaFactorMult}, meta_equity=${config.thusneldaMetaEquityUsdt} USD`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    if (this.symbols.length === 0) return;

    // 1. Fetch current prices for all symbols in the basket
    const prices = await this.fetchBasketPrices(marketPrice);

    // 2. Evaluate Global Equity Exit
    const exitExecuted = await this.evaluateGlobalExit(prices);
    if (exitExecuted) return;

    // 3. Evaluate Drawdown Guard
    const { totalCost, totalEquity, drawdownPct } = this.calculateEquityAndDrawdown(prices);
    const isBlockedByDrawdown = totalCost > 0 && drawdownPct >= config.thusneldaMaxDrawdownPct;

    log.info(`Thusnelda Basket: Equity=${totalEquity.toFixed(2)} USD | Cost=${totalCost.toFixed(2)} USD | Drawdown=${drawdownPct.toFixed(2)}% (Max: ${config.thusneldaMaxDrawdownPct}%) | State=${isBlockedByDrawdown ? 'BLOCKED' : 'OK'}`);

    if (isBlockedByDrawdown) {
      log.warn(`Thusnelda: Drawdown Guard active (${drawdownPct.toFixed(2)}% >= ${config.thusneldaMaxDrawdownPct}%). Purchases blocked.`);
      this.updateDashboard(prices, totalEquity, `BLOCKED: DD ${drawdownPct.toFixed(1)}%`);
      return;
    }

    // 4. Process a single symbol in rotation to prevent hitting API limits
    const symbol = this.symbols[this.currentSymbolIndex];
    this.currentSymbolIndex = (this.currentSymbolIndex + 1) % this.symbols.length;

    const currentSymbolPrice = prices[symbol];
    if (!currentSymbolPrice || currentSymbolPrice <= 0) {
      log.warn(`Thusnelda: Could not fetch price for ${symbol}. Skipping tick for this symbol.`);
      return;
    }

    // Evaluate entry for this symbol
    const pos = this.state.positions[symbol] || { symbol, avgBuyPrice: 0, accumulatedQty: 0, totalCost: 0 };
    const shouldBuy = pos.avgBuyPrice === 0 || currentSymbolPrice < pos.avgBuyPrice * config.thusneldaFactorMult;

    log.info(`Evaluating ${symbol}: Price=${currentSymbolPrice.toFixed(4)} | Avg=${pos.avgBuyPrice.toFixed(4)} | Trigger=${(pos.avgBuyPrice * config.thusneldaFactorMult).toFixed(4)} | Buy=${shouldBuy}`);

    if (shouldBuy) {
      await this.executeBuy(symbol, currentSymbolPrice);
    } else {
      this.updateDashboard(prices, totalEquity, `Running (Processed ${symbol})`);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Thusnelda keeping positions active.');
  }

  private async fetchBasketPrices(xrpPrice: number): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const symbol of this.symbols) {
      if (symbol === 'XRP') {
        prices[symbol] = xrpPrice;
        continue;
      }
      try {
        const binanceSymbol = `${symbol}USDT`;
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`);
        if (res.ok) {
          const data: any = await res.json();
          prices[symbol] = parseFloat(data.price);
        } else {
          prices[symbol] = 0;
        }
      } catch {
        prices[symbol] = 0;
      }
    }
    return prices;
  }

  private calculateEquityAndDrawdown(prices: Record<string, number>): { totalCost: number; totalEquity: number; drawdownPct: number } {
    let totalCost = 0;
    let totalEquity = 0;

    for (const symbol of this.symbols) {
      const pos = this.state.positions[symbol];
      if (pos && pos.accumulatedQty > 0) {
        totalCost += pos.totalCost;
        const currentPrice = prices[symbol] || 0;
        totalEquity += pos.accumulatedQty * currentPrice;
      }
    }

    const drawdownPct = totalCost > 0 ? Math.max(0, ((totalCost - totalEquity) / totalCost) * 100) : 0;
    return { totalCost, totalEquity, drawdownPct };
  }

  private async evaluateGlobalExit(prices: Record<string, number>): Promise<boolean> {
    const { totalCost, totalEquity } = this.calculateEquityAndDrawdown(prices);
    if (totalCost === 0) return false;

    if (totalEquity >= config.thusneldaMetaEquityUsdt) {
      log.warn(`¡Thusnelda Global Equity Target Reached! Equity=${totalEquity.toFixed(2)} USD >= Meta=${config.thusneldaMetaEquityUsdt} USD. Liquidating basket...`);

      for (const symbol of this.symbols) {
        const pos = this.state.positions[symbol];
        if (pos && pos.accumulatedQty > 0) {
          const currentPrice = prices[symbol] || 0;
          await this.executeSell(symbol, pos.accumulatedQty, currentPrice);
        }
      }

      db.logTransaction('THUSNELDA_BASKET_EXIT', '', 'FILLED', { totalCost, totalEquity });
      
      this.state.positions = {};
      this.saveState();
      return true;
    }

    return false;
  }

  private async executeBuy(symbol: string, price: number) {
    const quoteQty = config.thusneldaQuoteQty; // USD value to buy
    const buyQty = quoteQty / price;

    if (symbol === 'XRP') {
      // XRP nativo
      const maxBuyPrice = price * 1.01;
      const usdCost = (buyQty * maxBuyPrice).toFixed(4);

      const takerPays = (buyQty * 1000000).toString(); // drops
      const takerGets = {
        currency: 'USD',
        value: usdCost,
        issuer: this.usdIssuer
      };

      log.info(`Thusnelda: Buying XRP Spot (Qty: ${buyQty.toFixed(2)}, Cost: ${usdCost} USD)`);
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (buyResult.success && buyResult.sequence) {
        this.updatePositionState(symbol, price, buyQty, quoteQty);
        db.logTransaction('THUSNELDA_BUY', buyResult.hash || '', 'tesSUCCESS', { symbol, price, amount: buyQty });
      }
    } else {
      // IOU Token alternativo
      // Mapeamos el issuer de GateHub para todos los tokens de la testnet como pasarela multi-divisa
      const takerPays = {
        currency: symbol,
        value: buyQty.toFixed(6),
        issuer: this.usdIssuer
      };
      // Entregamos un 1% extra de USD para asegurar el llenado inmediato en el DEX
      const maxUsdCost = (quoteQty * 1.01).toFixed(4);
      const takerGets = {
        currency: 'USD',
        value: maxUsdCost,
        issuer: this.usdIssuer
      };

      log.info(`Thusnelda: Buying ${symbol} IOU (Qty: ${buyQty.toFixed(2)}, Cost: ${maxUsdCost} USD)`);
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (buyResult.success && buyResult.sequence) {
        this.updatePositionState(symbol, price, buyQty, quoteQty);
        db.logTransaction('THUSNELDA_BUY', buyResult.hash || '', 'tesSUCCESS', { symbol, price, amount: buyQty });
      } else {
        log.error(`Thusnelda: Failed to buy ${symbol}:`, buyResult.error);
      }
    }
  }

  private async executeSell(symbol: string, qty: number, price: number) {
    log.info(`Thusnelda: Liquidating position in ${symbol} (Qty: ${qty.toFixed(2)}, EstPrice: ${price.toFixed(4)})`);
    
    if (symbol === 'XRP') {
      const minSellPrice = price * 0.99;
      const usdValue = (qty * minSellPrice).toFixed(4);

      const takerPays = {
        currency: 'USD',
        value: usdValue,
        issuer: this.usdIssuer
      };
      const takerGets = (qty * 1000000).toString(); // drops

      try {
        const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        db.logTransaction('THUSNELDA_SELL', sellResult.hash || '', sellResult.success ? 'tesSUCCESS' : 'FAILED', { symbol, price, amount: qty });
      } catch (error) {
        log.error(`Thusnelda: Exception selling XRP:`, error);
      }
    } else {
      const minSellPrice = price * 0.99;
      const usdValue = (qty * minSellPrice).toFixed(4);

      const takerPays = {
        currency: 'USD',
        value: usdValue,
        issuer: this.usdIssuer
      };
      const takerGets = {
        currency: symbol,
        value: qty.toFixed(6),
        issuer: this.usdIssuer
      };

      try {
        const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        db.logTransaction('THUSNELDA_SELL', sellResult.hash || '', sellResult.success ? 'tesSUCCESS' : 'FAILED', { symbol, price, amount: qty });
      } catch (error) {
        log.error(`Thusnelda: Exception selling ${symbol}:`, error);
      }
    }
  }

  private updatePositionState(symbol: string, buyPrice: number, qty: number, cost: number) {
    const pos = this.state.positions[symbol] || { symbol, avgBuyPrice: 0, accumulatedQty: 0, totalCost: 0 };
    
    pos.accumulatedQty += qty;
    pos.totalCost += cost;
    pos.avgBuyPrice = pos.totalCost / pos.accumulatedQty;

    this.state.positions[symbol] = pos;
    this.saveState();
  }

  private saveState() {
    db.saveCustomData('thusnelda_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('thusnelda_state');
    if (saved && saved.positions) {
      this.state = saved;
      log.info(`Thusnelda: Restored positions for [${Object.keys(this.state.positions).join(', ')}] from DB.`);
    }
  }

  private async updateDashboard(prices: Record<string, number>, totalEquity: number, statusText: string) {
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

      const activeSymbolsCount = Object.values(this.state.positions).filter(p => p.accumulatedQty > 0).length;

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: totalEquity.toFixed(2), // We display total basket equity value here
        buyTarget: config.thusneldaMetaEquityUsdt.toString(),
        sellTarget: 'None',
        activeBuySeq: `Basket size: ${this.symbols.length}`,
        activeSellSeq: `Active positions: ${activeSymbolsCount}`,
        strategyName: 'Thusnelda Basket DCA',
        activeRungs: `${activeSymbolsCount} / ${this.symbols.length}`,
        botStatus: statusText
      });
    } catch (error) {
      log.error('Thusnelda: Dashboard update failed:', error);
    }
  }
}
