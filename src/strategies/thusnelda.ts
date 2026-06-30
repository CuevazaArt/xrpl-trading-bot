import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface TokenPosition { symbol: string; avgBuyPrice: number; accumulatedQty: number; totalCost: number; }
interface ThusneldaState { positions: Record<string, TokenPosition>; }

export class XRPLThusneldaStrategy extends AbstractStrategy {
  public readonly name = 'thusnelda';
  private state: ThusneldaState = { positions: {} };

  private symbols: string[] = [];
  private currentSymbolIndex = 0;

  protected async onInit(): Promise<void> {
    this.symbols = config.thusneldaSymbolsCsv.split(',').map((s: string) => s.trim().toUpperCase());
    this.loadState();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Thusnelda Basket DCA' });
    this.log.info(`Thusnelda initialized: symbols=[${this.symbols.join(', ')}], factor_mult=${config.thusneldaFactorMult}, meta_equity=${config.thusneldaMetaEquityUsdt} USD`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    if (this.symbols.length === 0) return;

    const prices = await this.fetchBasketPrices(marketPrice);
    const exitExecuted = await this.evaluateGlobalExit(prices);
    if (exitExecuted) return;

    const { totalCost, totalEquity, drawdownPct } = this.calculateEquityAndDrawdown(prices);
    const isBlockedByDrawdown = totalCost > 0 && drawdownPct >= config.thusneldaMaxDrawdownPct;

    this.log.info(`Thusnelda Basket: Equity=${totalEquity.toFixed(2)} USD | Cost=${totalCost.toFixed(2)} USD | Drawdown=${drawdownPct.toFixed(2)}%`);

    if (isBlockedByDrawdown) {
      this.log.warn(`Thusnelda: Drawdown Guard active (${drawdownPct.toFixed(2)}%). Purchases blocked.`);
      await this.updateThusneldaDashboard(prices, totalEquity, `BLOCKED: DD ${drawdownPct.toFixed(1)}%`);
      return;
    }

    const symbol = this.symbols[this.currentSymbolIndex];
    this.currentSymbolIndex = (this.currentSymbolIndex + 1) % this.symbols.length;

    const currentSymbolPrice = prices[symbol];
    if (!currentSymbolPrice || currentSymbolPrice <= 0) { this.log.warn(`Could not fetch price for ${symbol}.`); return; }

    const pos = this.state.positions[symbol] || { symbol, avgBuyPrice: 0, accumulatedQty: 0, totalCost: 0 };
    const shouldBuy = pos.avgBuyPrice === 0 || currentSymbolPrice < pos.avgBuyPrice * config.thusneldaFactorMult;

    this.log.info(`Evaluating ${symbol}: Price=${currentSymbolPrice.toFixed(4)} | Avg=${pos.avgBuyPrice.toFixed(4)} | Buy=${shouldBuy}`);

    if (shouldBuy) { await this.executeBuy(symbol, currentSymbolPrice); }
    else { await this.updateThusneldaDashboard(prices, totalEquity, `Running (Processed ${symbol})`); }
  }

  async cleanup(): Promise<void> { this.log.info('Cleanup: Thusnelda keeping positions active.'); }

  private async fetchBasketPrices(xrpPrice: number): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const symbol of this.symbols) {
      if (symbol === 'XRP') { prices[symbol] = xrpPrice; continue; }
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        if (res.ok) { const data: any = await res.json(); prices[symbol] = parseFloat(data.price); }
        else { prices[symbol] = 0; }
      } catch { prices[symbol] = 0; }
    }
    return prices;
  }

  private calculateEquityAndDrawdown(prices: Record<string, number>): { totalCost: number; totalEquity: number; drawdownPct: number } {
    let totalCost = 0, totalEquity = 0;
    for (const symbol of this.symbols) {
      const pos = this.state.positions[symbol];
      if (pos && pos.accumulatedQty > 0) {
        totalCost += pos.totalCost;
        totalEquity += pos.accumulatedQty * (prices[symbol] || 0);
      }
    }
    const drawdownPct = totalCost > 0 ? Math.max(0, ((totalCost - totalEquity) / totalCost) * 100) : 0;
    return { totalCost, totalEquity, drawdownPct };
  }

  private async evaluateGlobalExit(prices: Record<string, number>): Promise<boolean> {
    const { totalCost, totalEquity } = this.calculateEquityAndDrawdown(prices);
    if (totalCost === 0) return false;
    if (totalEquity >= config.thusneldaMetaEquityUsdt) {
      this.log.warn(`¡Thusnelda Global Equity Target Reached! Equity=${totalEquity.toFixed(2)} USD. Liquidating basket...`);
      for (const symbol of this.symbols) {
        const pos = this.state.positions[symbol];
        if (pos && pos.accumulatedQty > 0) { await this.executeSell(symbol, pos.accumulatedQty, prices[symbol] || 0); }
      }
      db.logTransaction('THUSNELDA_BASKET_EXIT', '', 'FILLED', { totalCost, totalEquity });
      this.state.positions = {};
      this.saveState();
      return true;
    }
    return false;
  }

  private async executeBuy(symbol: string, price: number) {
    const quoteQty = config.thusneldaQuoteQty;
    const buyQty = quoteQty / price;

    if (symbol === 'XRP') {
      const maxBuyPrice = price * 1.01;
      const usdCost = (buyQty * maxBuyPrice).toFixed(4);
      const takerPays = (buyQty * 1000000).toString();
      const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

      this.log.info(`Thusnelda: Buying XRP Spot (Qty: ${buyQty.toFixed(2)}, Cost: ${usdCost} USD)`);
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (buyResult.success && buyResult.sequence) {
        this.updatePositionState(symbol, price, buyQty, quoteQty);
        db.logTransaction('THUSNELDA_BUY', buyResult.hash || '', 'tesSUCCESS', { symbol, price, amount: buyQty });
      }
    } else {
      const takerPays = { currency: symbol, value: buyQty.toFixed(6), issuer: this.usdIssuer };
      const maxUsdCost = (quoteQty * 1.01).toFixed(4);
      const takerGets = { currency: 'USD', value: maxUsdCost, issuer: this.usdIssuer };

      this.log.info(`Thusnelda: Buying ${symbol} IOU (Qty: ${buyQty.toFixed(2)}, Cost: ${maxUsdCost} USD)`);
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (buyResult.success && buyResult.sequence) {
        this.updatePositionState(symbol, price, buyQty, quoteQty);
        db.logTransaction('THUSNELDA_BUY', buyResult.hash || '', 'tesSUCCESS', { symbol, price, amount: buyQty });
      } else { this.log.error(`Thusnelda: Failed to buy ${symbol}:`, buyResult.error); }
    }
  }

  private async executeSell(symbol: string, qty: number, price: number) {
    this.log.info(`Thusnelda: Liquidating ${symbol} (Qty: ${qty.toFixed(2)}, Price: ${price.toFixed(4)})`);
    const minSellPrice = price * 0.99;
    const usdValue = (qty * minSellPrice).toFixed(4);

    if (symbol === 'XRP') {
      const takerPays = { currency: 'USD', value: usdValue, issuer: this.usdIssuer };
      const takerGets = (qty * 1000000).toString();
      try {
        const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        db.logTransaction('THUSNELDA_SELL', sellResult.hash || '', sellResult.success ? 'tesSUCCESS' : 'FAILED', { symbol, price, amount: qty });
      } catch (error) { this.log.error(`Exception selling XRP:`, error); }
    } else {
      const takerPays = { currency: 'USD', value: usdValue, issuer: this.usdIssuer };
      const takerGets = { currency: symbol, value: qty.toFixed(6), issuer: this.usdIssuer };
      try {
        const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
        db.logTransaction('THUSNELDA_SELL', sellResult.hash || '', sellResult.success ? 'tesSUCCESS' : 'FAILED', { symbol, price, amount: qty });
      } catch (error) { this.log.error(`Exception selling ${symbol}:`, error); }
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

  private saveState() { db.saveCustomData('thusnelda_state', this.state); }
  private loadState() {
    const saved = db.getCustomData('thusnelda_state');
    if (saved && saved.positions) { this.state = saved; this.log.info(`Thusnelda: Restored positions for [${Object.keys(this.state.positions).join(', ')}].`); }
  }

  private async updateThusneldaDashboard(prices: Record<string, number>, totalEquity: number, statusText: string) {
    const activeSymbolsCount = Object.values(this.state.positions).filter(p => p.accumulatedQty > 0).length;
    await this.updateDashboardWithBalances({
      midPrice: totalEquity.toFixed(2), buyTarget: config.thusneldaMetaEquityUsdt.toString(), sellTarget: 'None',
      activeBuySeq: `Basket size: ${this.symbols.length}`, activeSellSeq: `Active positions: ${activeSymbolsCount}`,
      strategyName: 'Thusnelda Basket DCA', activeRungs: `${activeSymbolsCount} / ${this.symbols.length}`, botStatus: statusText
    });
  }
}
