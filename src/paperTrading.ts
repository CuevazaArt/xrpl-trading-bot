import fs from 'fs';
import path from 'path';
import { Wallet, Amount } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { createLogger } from './logger.js';
import { config } from './config.js';
import { db } from './db.js';

const log = createLogger('PaperTrading');

// =====================================================================
// TIPOS
// =====================================================================

interface PaperTrade {
  id: number;
  timestamp: string;
  side: 'BUY' | 'SELL';
  venue: 'DEX' | 'CEX';
  qtyXrp: number;
  priceUsdt: number;
  costUsdt: number;
  feeUsdt: number;
  portfolioAfter: { usdt: number; xrp: number };
}

interface PaperPortfolio {
  usdt: number;
  xrp: number;
  totalValueUsdt: number;
  pnlUsdt: number;
  pnlPct: number;
}

interface PaperMetrics {
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  netPnlUsdt: number;
  maxDrawdownPct: number;
  peakValueUsdt: number;
  avgTradeReturnPct: number;
}

interface PaperSnapshot {
  timestamp: string;
  totalValueUsdt: number;
  xrpPrice: number;
  xrp: number;
  usdt: number;
}

interface PaperTradingData {
  config: {
    initialBalanceUsdt: number;
    startTimestamp: string;
    strategy: string;
  };
  portfolio: PaperPortfolio;
  trades: PaperTrade[];
  metrics: PaperMetrics;
  snapshots: PaperSnapshot[];
}

// =====================================================================
// PAPER TRADING DATABASE
// =====================================================================

/**
 * Base de datos dedicada para paper trading.
 * Almacena en data/paper_trades.json — independiente de db.json
 */
class PaperTradingDB {
  private data!: PaperTradingData;
  private dbPath?: string;
  private isTest: boolean;

  constructor(initialBalance: number, strategy: string) {
    this.isTest = process.env.NODE_ENV === 'test';

    if (this.isTest) {
      const dir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.dbPath = path.join(dir, 'paper_trades.json');
      if (fs.existsSync(this.dbPath)) {
        try {
          const content = fs.readFileSync(this.dbPath, 'utf8');
          this.data = JSON.parse(content);
          return;
        } catch {
          // ignore
        }
      }
    } else {
      const saved = db.getCustomData('paper_trading_state');
      if (saved) {
        this.data = saved;
        log.info(`Paper Trading: Restaurado (${this.data.trades.length} trades, P&L: ${this.data.portfolio.pnlUsdt >= 0 ? '+' : ''}$${this.data.portfolio.pnlUsdt.toFixed(2)})`);
        return;
      }
    }

    // Nueva sesión
    this.data = {
      config: {
        initialBalanceUsdt: initialBalance,
        startTimestamp: new Date().toISOString(),
        strategy,
      },
      portfolio: {
        usdt: initialBalance,
        xrp: 0,
        totalValueUsdt: initialBalance,
        pnlUsdt: 0,
        pnlPct: 0,
      },
      trades: [],
      metrics: {
        totalTrades: 0, buyTrades: 0, sellTrades: 0,
        winningTrades: 0, losingTrades: 0, winRate: 0,
        grossProfitUsdt: 0, grossLossUsdt: 0, netPnlUsdt: 0,
        maxDrawdownPct: 0, peakValueUsdt: initialBalance,
        avgTradeReturnPct: 0,
      },
      snapshots: [],
    };
    this.save();
    log.info(`Paper Trading: Nueva sesión iniciada con $${initialBalance} USDT`);
  }

  getData(): PaperTradingData { return this.data; }
  getPortfolio(): PaperPortfolio { return this.data.portfolio; }
  getMetrics(): PaperMetrics { return this.data.metrics; }
  getTrades(): PaperTrade[] { return this.data.trades; }
  getLastTrades(n: number): PaperTrade[] { return this.data.trades.slice(-n); }

  /**
   * Registra un trade virtual y recalcula métricas.
   */
  recordTrade(
    side: 'BUY' | 'SELL',
    venue: 'DEX' | 'CEX',
    qtyXrp: number,
    priceUsdt: number,
    feeEstPct: number = 0.1
  ): PaperTrade | null {
    const p = this.data.portfolio;
    const costUsdt = qtyXrp * priceUsdt;
    const feeUsdt = costUsdt * (feeEstPct / 100);

    if (side === 'BUY') {
      const totalCost = costUsdt + feeUsdt;
      if (totalCost > p.usdt) {
        log.warn(`Paper BUY rechazado: costo $${totalCost.toFixed(2)} > saldo $${p.usdt.toFixed(2)}`);
        return null;
      }
      p.usdt -= totalCost;
      p.xrp += qtyXrp;
    } else {
      if (qtyXrp > p.xrp) {
        log.warn(`Paper SELL rechazado: ${qtyXrp} XRP > saldo ${p.xrp.toFixed(1)} XRP`);
        return null;
      }
      p.xrp -= qtyXrp;
      p.usdt += costUsdt - feeUsdt;
    }

    const trade: PaperTrade = {
      id: this.data.trades.length + 1,
      timestamp: new Date().toISOString(),
      side, venue, qtyXrp, priceUsdt, costUsdt, feeUsdt,
      portfolioAfter: { usdt: p.usdt, xrp: p.xrp },
    };

    this.data.trades.push(trade);
    // Cap a 500 trades
    if (this.data.trades.length > 500) {
      this.data.trades = this.data.trades.slice(-500);
    }

    this.recalcMetrics(priceUsdt);
    this.save();

    log.info(`📝 Paper ${side} ${qtyXrp.toFixed(1)} XRP @ $${priceUsdt.toFixed(4)} [${venue}] | Fee: $${feeUsdt.toFixed(4)} | Portfolio: $${p.totalValueUsdt.toFixed(2)} (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%)`);
    return trade;
  }

  /**
   * Toma un snapshot periódico del portfolio.
   */
  takeSnapshot(xrpPrice: number): void {
    this.updatePortfolioValue(xrpPrice);
    const p = this.data.portfolio;

    this.data.snapshots.push({
      timestamp: new Date().toISOString(),
      totalValueUsdt: p.totalValueUsdt,
      xrpPrice,
      xrp: p.xrp,
      usdt: p.usdt,
    });

    // Cap a 1000 snapshots
    if (this.data.snapshots.length > 1000) {
      this.data.snapshots = this.data.snapshots.slice(-1000);
    }
    this.save();
  }

  /**
   * Actualiza el valor total del portfolio con el precio actual de XRP.
   */
  updatePortfolioValue(xrpPrice: number): void {
    const p = this.data.portfolio;
    p.totalValueUsdt = p.usdt + (p.xrp * xrpPrice);
    p.pnlUsdt = p.totalValueUsdt - this.data.config.initialBalanceUsdt;
    p.pnlPct = (p.pnlUsdt / this.data.config.initialBalanceUsdt) * 100;
  }

  private recalcMetrics(currentPrice: number): void {
    this.updatePortfolioValue(currentPrice);

    const m = this.data.metrics;
    const p = this.data.portfolio;
    const trades = this.data.trades;

    m.totalTrades = trades.length;
    m.buyTrades = trades.filter(t => t.side === 'BUY').length;
    m.sellTrades = trades.filter(t => t.side === 'SELL').length;
    m.netPnlUsdt = p.pnlUsdt;

    // Win/loss basado en pares de trades (compra→venta)
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const buys: PaperTrade[] = [];
    
    for (const trade of trades) {
      if (trade.side === 'BUY') {
        buys.push(trade);
      } else if (trade.side === 'SELL' && buys.length > 0) {
        const matchedBuy = buys.shift()!;
        const profit = (trade.priceUsdt - matchedBuy.priceUsdt) * trade.qtyXrp - trade.feeUsdt - matchedBuy.feeUsdt;
        if (profit > 0) {
          wins++;
          grossProfit += profit;
        } else {
          losses++;
          grossLoss += Math.abs(profit);
        }
      }
    }

    m.winningTrades = wins;
    m.losingTrades = losses;
    m.winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
    m.grossProfitUsdt = grossProfit;
    m.grossLossUsdt = grossLoss;

    // Max drawdown
    if (p.totalValueUsdt > m.peakValueUsdt) {
      m.peakValueUsdt = p.totalValueUsdt;
    }
    const drawdownPct = ((m.peakValueUsdt - p.totalValueUsdt) / m.peakValueUsdt) * 100;
    if (drawdownPct > m.maxDrawdownPct) {
      m.maxDrawdownPct = drawdownPct;
    }

    // Avg trade return
    if (m.totalTrades > 0) {
      m.avgTradeReturnPct = (m.netPnlUsdt / this.data.config.initialBalanceUsdt * 100) / m.totalTrades;
    }
  }

  /**
   * Reset para nueva sesión (mantiene el archivo).
   */
  reset(initialBalance: number, strategy: string): void {
    this.data.config = {
      initialBalanceUsdt: initialBalance,
      startTimestamp: new Date().toISOString(),
      strategy,
    };
    this.data.portfolio = {
      usdt: initialBalance, xrp: 0,
      totalValueUsdt: initialBalance, pnlUsdt: 0, pnlPct: 0,
    };
    this.data.trades = [];
    this.data.metrics = {
      totalTrades: 0, buyTrades: 0, sellTrades: 0,
      winningTrades: 0, losingTrades: 0, winRate: 0,
      grossProfitUsdt: 0, grossLossUsdt: 0, netPnlUsdt: 0,
      maxDrawdownPct: 0, peakValueUsdt: initialBalance,
      avgTradeReturnPct: 0,
    };
    this.data.snapshots = [];
    this.save();
    log.info(`Paper Trading: Sesión reseteada con $${initialBalance} USDT`);
  }

  private save(): void {
    if (this.isTest && this.dbPath) {
      try {
        fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (error) {
        log.error('Error guardando paper trading DB:', error);
      }
    } else {
      db.saveCustomData('paper_trading_state', this.data);
    }
  }
}

// =====================================================================
// PAPER ORDER MANAGER — Wrapper que intercepta trades
// =====================================================================

/**
 * PaperOrderManager: Drop-in replacement del XRPLOrderManager real.
 * 
 * Las estrategias lo reciben en vez del real y no notan la diferencia.
 * Intercepta createMarketOrder y createLimitOrder, ejecutando trades
 * virtuales contra el precio actual del oráculo.
 */
export class PaperOrderManager extends XRPLOrderManager {
  private paperDb: PaperTradingDB;
  private lastOraclePrice: number = 0;
  private sequenceCounter: number = 100000; // Secuencias virtuales

  constructor(client: any, initialBalance: number, strategy: string) {
    super(client);
    this.paperDb = new PaperTradingDB(initialBalance, strategy);
  }

  /**
   * Actualiza el precio de referencia del oráculo.
   * Llamar antes de cada tick para que los trades simulados usen el precio correcto.
   */
  setOraclePrice(price: number): void {
    this.lastOraclePrice = price;
  }

  getDB(): PaperTradingDB { return this.paperDb; }

  /**
   * Intercepta market orders y ejecuta trade virtual.
   */
  async createMarketOrder(wallet: Wallet, takerPays: Amount, takerGets: Amount) {
    const { side, qtyXrp, price } = this.parseOrder(takerPays, takerGets);

    const trade = this.paperDb.recordTrade(side, 'DEX', qtyXrp, price, 0.01); // XRPL fee ~0.01%
    this.sequenceCounter++;

    if (trade) {
      return {
        success: true as const,
        hash: `PAPER_${trade.id}_${Date.now().toString(36)}`,
        sequence: this.sequenceCounter,
        result: null as any,
      };
    } else {
      return {
        success: false as const,
        error: 'Paper: fondos insuficientes',
        result: null as any,
      };
    }
  }

  /**
   * Intercepta limit orders y ejecuta trade virtual (asumiendo fill inmediato).
   */
  async createLimitOrder(wallet: Wallet, takerPays: Amount, takerGets: Amount) {
    const { side, qtyXrp, price } = this.parseOrder(takerPays, takerGets);

    const trade = this.paperDb.recordTrade(side, 'DEX', qtyXrp, price, 0.01);
    this.sequenceCounter++;

    if (trade) {
      return {
        success: true as const,
        hash: `PAPER_LIMIT_${trade.id}_${Date.now().toString(36)}`,
        sequence: this.sequenceCounter,
        result: null as any,
      };
    } else {
      return {
        success: false as const,
        error: 'Paper: fondos insuficientes',
        result: null as any,
      };
    }
  }

  /**
   * Cancel es no-op en paper trading.
   */
  async cancelOrder(wallet: Wallet, offerSequence: number) {
    log.debug(`Paper: cancelOrder seq=${offerSequence} (no-op)`);
    return {
      success: true,
      hash: `PAPER_CANCEL_${Date.now().toString(36)}`,
      sequence: offerSequence,
      result: null as any,
    };
  }

  /**
   * Parsea una orden XRPL (takerPays/takerGets) para extraer dirección, qty y precio.
   */
  private parseOrder(takerPays: Amount, takerGets: Amount): { side: 'BUY' | 'SELL'; qtyXrp: number; price: number } {
    // Si takerPays es string → es XRP en drops → estamos COMPRANDO XRP
    if (typeof takerPays === 'string') {
      const qtyXrp = parseInt(takerPays, 10) / 1_000_000;
      const usdValue = typeof takerGets === 'object' ? parseFloat(takerGets.value) : 0;
      const price = usdValue > 0 && qtyXrp > 0 ? usdValue / qtyXrp : this.lastOraclePrice;
      return { side: 'BUY', qtyXrp, price: price || this.lastOraclePrice };
    }

    // Si takerGets es string → es XRP en drops → estamos VENDIENDO XRP
    if (typeof takerGets === 'string') {
      const qtyXrp = parseInt(takerGets, 10) / 1_000_000;
      const usdValue = typeof takerPays === 'object' ? parseFloat(takerPays.value) : 0;
      const price = usdValue > 0 && qtyXrp > 0 ? usdValue / qtyXrp : this.lastOraclePrice;
      return { side: 'SELL', qtyXrp, price: price || this.lastOraclePrice };
    }

    // Fallback: ambos son objetos (IOU-IOU swap)
    return { side: 'BUY', qtyXrp: 0, price: this.lastOraclePrice };
  }
}
