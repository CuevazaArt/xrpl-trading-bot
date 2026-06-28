import { createLogger } from './logger.js';
import { db } from './db.js';

const log = createLogger('PnLTracker');

// =====================================================================
// TIPOS
// =====================================================================

export interface VerifiedFill {
  side: 'BUY' | 'SELL';
  price: number;          // Precio real de ejecución
  amount: number;         // XRP real intercambiado
  usdAmount: number;      // USD real intercambiado
  feeDrops: number;       // Fee pagado en drops
  hash: string;           // TX hash
  timestamp: string;
  mode: string;           // Carousel mode
}

interface PendingLeg {
  fill: VerifiedFill;
  createdAt: string;
}

export interface RoundtripTrade {
  id: number;
  buy: VerifiedFill;
  sell: VerifiedFill;
  grossProfitUsd: number;  // (sellPrice - buyPrice) * amount
  feesUsd: number;         // Total fees en USD
  netProfitUsd: number;    // grossProfit - fees
  profitPct: number;       // netProfit / inversión
}

export interface PnLSummary {
  totalFills: number;
  completedRoundtrips: number;
  pendingBuys: number;
  pendingSells: number;
  totalGrossProfitUsd: number;
  totalFeesUsd: number;
  totalNetProfitUsd: number;
  winRate: number;
  avgProfitPerRoundtrip: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
  unrealizedPnl: string;   // Descripción del inventario abierto
}

// =====================================================================
// P&L TRACKER
// =====================================================================

export class PnLTracker {
  private pendingBuys: PendingLeg[] = [];
  private pendingSells: PendingLeg[] = [];
  private completedRoundtrips: RoundtripTrade[] = [];
  private totalFills = 0;
  private nextId = 1;

  constructor() {
    // Intentar restaurar estado desde db
    this.loadState();
  }

  /**
   * Registra un fill verificado y intenta emparejar roundtrips.
   * - BUY fill → se guarda en cola de pendingBuys
   * - SELL fill → se empareja con el buy más antiguo (FIFO)
   * - Si no hay buy pendiente, el sell queda en pendingSells
   */
  recordFill(fill: VerifiedFill): RoundtripTrade | null {
    this.totalFills++;

    if (fill.side === 'BUY') {
      // Intentar emparejar con un sell pendiente (caso: vendió antes de comprar)
      if (this.pendingSells.length > 0) {
        const sellLeg = this.pendingSells.shift()!;
        const roundtrip = this.createRoundtrip(fill, sellLeg.fill);
        this.completedRoundtrips.push(roundtrip);
        this.saveState();
        log.info(`💰 Roundtrip #${roundtrip.id} completado! Net P&L: $${roundtrip.netProfitUsd.toFixed(4)} (${roundtrip.profitPct.toFixed(2)}%)`);
        return roundtrip;
      }
      // Sin sell pendiente → guardar buy para emparejar después
      this.pendingBuys.push({ fill, createdAt: new Date().toISOString() });
      log.info(`📥 BUY registrado a $${fill.price.toFixed(4)} — ${this.pendingBuys.length} compra(s) pendiente(s) de emparejar`);
    } else {
      // SELL: intentar emparejar con un buy pendiente (FIFO)
      if (this.pendingBuys.length > 0) {
        const buyLeg = this.pendingBuys.shift()!;
        const roundtrip = this.createRoundtrip(buyLeg.fill, fill);
        this.completedRoundtrips.push(roundtrip);
        this.saveState();
        log.info(`💰 Roundtrip #${roundtrip.id} completado! Net P&L: $${roundtrip.netProfitUsd.toFixed(4)} (${roundtrip.profitPct.toFixed(2)}%)`);
        return roundtrip;
      }
      // Sin buy pendiente → guardar sell para emparejar después
      this.pendingSells.push({ fill, createdAt: new Date().toISOString() });
      log.info(`📤 SELL registrado a $${fill.price.toFixed(4)} — ${this.pendingSells.length} venta(s) pendiente(s) de emparejar`);
    }

    this.saveState();
    return null;
  }

  /**
   * Crea un roundtrip trade emparejando un buy con un sell.
   */
  private createRoundtrip(buy: VerifiedFill, sell: VerifiedFill): RoundtripTrade {
    // Usar el menor amount (en caso de fills parciales)
    const amount = Math.min(buy.amount, sell.amount);
    const grossProfitUsd = (sell.price - buy.price) * amount;
    
    // Fees: convertir drops a XRP, luego a USD usando precio promedio
    const avgPrice = (buy.price + sell.price) / 2;
    const totalFeeDrops = buy.feeDrops + sell.feeDrops;
    const feesUsd = (totalFeeDrops / 1_000_000) * avgPrice;
    
    const netProfitUsd = grossProfitUsd - feesUsd;
    const investment = buy.price * amount;
    const profitPct = investment > 0 ? (netProfitUsd / investment) * 100 : 0;

    return {
      id: this.nextId++,
      buy,
      sell,
      grossProfitUsd,
      feesUsd,
      netProfitUsd,
      profitPct,
    };
  }

  /**
   * Retorna el resumen de P&L acumulado.
   */
  getSummary(): PnLSummary {
    const wins = this.completedRoundtrips.filter(r => r.netProfitUsd > 0).length;
    const totalNet = this.completedRoundtrips.reduce((sum, r) => sum + r.netProfitUsd, 0);
    const totalGross = this.completedRoundtrips.reduce((sum, r) => sum + r.grossProfitUsd, 0);
    const totalFees = this.completedRoundtrips.reduce((sum, r) => sum + r.feesUsd, 0);
    const best = this.completedRoundtrips.length > 0 
      ? Math.max(...this.completedRoundtrips.map(r => r.netProfitUsd)) : 0;
    const worst = this.completedRoundtrips.length > 0 
      ? Math.min(...this.completedRoundtrips.map(r => r.netProfitUsd)) : 0;

    // Inventario abierto
    const unrealized = this.pendingBuys.length > 0
      ? `${this.pendingBuys.length} compra(s) sin venta`
      : this.pendingSells.length > 0
        ? `${this.pendingSells.length} venta(s) sin compra`
        : 'Sin posición abierta';

    return {
      totalFills: this.totalFills,
      completedRoundtrips: this.completedRoundtrips.length,
      pendingBuys: this.pendingBuys.length,
      pendingSells: this.pendingSells.length,
      totalGrossProfitUsd: totalGross,
      totalFeesUsd: totalFees,
      totalNetProfitUsd: totalNet,
      winRate: this.completedRoundtrips.length > 0 ? (wins / this.completedRoundtrips.length) * 100 : 0,
      avgProfitPerRoundtrip: this.completedRoundtrips.length > 0 ? totalNet / this.completedRoundtrips.length : 0,
      bestTradeUsd: best,
      worstTradeUsd: worst,
      unrealizedPnl: unrealized,
    };
  }

  /**
   * Formatea el resumen para logging.
   */
  formatSummaryLog(): string[] {
    const s = this.getSummary();
    const pnlEmoji = s.totalNetProfitUsd > 0 ? '📈' : s.totalNetProfitUsd < 0 ? '📉' : '➖';
    const pnlSign = s.totalNetProfitUsd >= 0 ? '+' : '';

    const lines: string[] = [
      `💰 ═══ P&L Report ═══════════════════════════`,
      `  Fills: ${s.totalFills} total | ${s.completedRoundtrips} roundtrips | ${s.pendingBuys}B/${s.pendingSells}S pendientes`,
      `  ${pnlEmoji} Net P&L: ${pnlSign}$${s.totalNetProfitUsd.toFixed(4)}  (gross: $${s.totalGrossProfitUsd.toFixed(4)} − fees: $${s.totalFeesUsd.toFixed(4)})`,
    ];

    if (s.completedRoundtrips > 0) {
      lines.push(`  Win rate: ${s.winRate.toFixed(0)}% | Avg/trade: $${s.avgProfitPerRoundtrip.toFixed(4)} | Best: $${s.bestTradeUsd.toFixed(4)} | Worst: $${s.worstTradeUsd.toFixed(4)}`);
    }

    lines.push(`  Posición: ${s.unrealizedPnl}`);
    lines.push(`💰 ═════════════════════════════════════════`);

    return lines;
  }

  // =====================================================================
  // PERSISTENCIA
  // =====================================================================

  private saveState(): void {
    db.saveCustomData('pnl', {
      pendingBuys: this.pendingBuys,
      pendingSells: this.pendingSells,
      completedRoundtrips: this.completedRoundtrips.slice(-50), // Guardar últimos 50
      totalFills: this.totalFills,
      nextId: this.nextId,
    });
  }

  private loadState(): void {
    const saved = db.getCustomData('pnl');
    if (saved) {
      this.pendingBuys = saved.pendingBuys || [];
      this.pendingSells = saved.pendingSells || [];
      this.completedRoundtrips = saved.completedRoundtrips || [];
      this.totalFills = saved.totalFills || 0;
      this.nextId = saved.nextId || 1;
      log.info(`Estado P&L restaurado: ${this.completedRoundtrips.length} roundtrips, ${this.pendingBuys.length} buys pendientes, ${this.pendingSells.length} sells pendientes`);
    }
  }
}
