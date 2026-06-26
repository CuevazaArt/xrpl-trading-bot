import { createLogger } from './logger.js';
import { flags } from './cliFlags.js';
import type { HealthSnapshot } from './healthMonitor.js';

const log = createLogger('CLIDashboard');

// =====================================================================
// ANSI ESCAPE HELPERS
// =====================================================================

const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const C = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
  magenta: `${ESC}[35m`,
  white: `${ESC}[37m`,
  bgDark: `${ESC}[48;5;235m`,
  bgBlue: `${ESC}[44m`,
};

// =====================================================================
// CLI DASHBOARD
// =====================================================================

interface TradeEntry {
  time: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  venue: string;
  pnl: number;
}

/**
 * Interface de terminal en tiempo real.
 * 
 * Renderiza el estado completo del bot usando ANSI escape codes.
 * Se refresca en cada tick (llamar update() desde el strategy manager).
 * Compatible con Windows Terminal, PowerShell, y terminales UNIX.
 */
export class CLIDashboard {
  private lastSnapshot: HealthSnapshot | null = null;
  private recentTrades: TradeEntry[] = [];
  private isActive: boolean = false;
  private width: number = 64;

  start(): void {
    this.isActive = true;
    process.stdout.write(HIDE_CURSOR);
    this.render();

    // Mostrar cursor al salir
    process.on('exit', () => {
      process.stdout.write(SHOW_CURSOR);
    });

    log.debug('CLI Dashboard activado');
  }

  stop(): void {
    this.isActive = false;
    process.stdout.write(SHOW_CURSOR);
  }

  /**
   * Actualiza el dashboard con un nuevo snapshot de salud.
   * Llamar desde el strategy manager en cada tick.
   */
  update(snapshot: HealthSnapshot): void {
    this.lastSnapshot = snapshot;
    if (this.isActive) {
      this.render();
    }
  }

  /**
   * Agrega un trade reciente para mostrar en la tabla de últimos trades.
   */
  addTrade(trade: TradeEntry): void {
    this.recentTrades.push(trade);
    if (this.recentTrades.length > 5) {
      this.recentTrades.shift();
    }
  }

  // =====================================================================
  // RENDERIZADO
  // =====================================================================

  private render(): void {
    const s = this.lastSnapshot;
    const lines: string[] = [];
    const W = this.width;

    // ─── HEADER ───
    lines.push(this.boxTop(W));
    lines.push(this.boxLine(`  🤖 PECUNATOR v1.0 — XRPL Trading Bot`, W));
    const mode = flags.paperTrading ? 'PAPER TRADING' : 'LIVE';
    const strategy = s?.strategy || 'loading...';
    lines.push(this.boxLine(`  Strategy: ${strategy} | Mode: ${mode}`, W));
    lines.push(this.boxMid(W));

    if (!s) {
      lines.push(this.boxLine(`  ⏳ Esperando primer tick...`, W));
      lines.push(this.boxBottom(W));
      this.flush(lines);
      return;
    }

    // ─── STATUS ───
    const statusIcon = s.online ? `${C.green}🟢 ONLINE${C.reset}` : `${C.red}🔴 OFFLINE${C.reset}`;
    lines.push(this.boxLine(`  ${statusIcon} | Ledger #${s.ledgerHeight.toLocaleString()} | Tick #${s.tickCount}`, W));

    const priceStr = s.oracle.xrpPrice > 0 ? `$${s.oracle.xrpPrice.toFixed(4)}` : 'N/A';
    const confStr = `${(s.oracle.confidence * 100).toFixed(0)}% conf`;
    lines.push(this.boxLine(`  📊 XRP/USD: ${priceStr} (${s.oracle.activeSources}/${s.oracle.totalSources} sources, ${confStr})`, W));
    lines.push(this.boxLine('', W));

    // ─── FUND DISTRIBUTION ───
    lines.push(this.boxLine(`  ┌─ FUND DISTRIBUTION ${'─'.repeat(Math.max(0, W - 28))}┐`, W));
    const f = s.funds;
    const dexBar = this.progressBar(f.dex.xrp, Math.max(f.dex.xrp, f.cex.xrp, 1), 12);
    const cexBar = this.progressBar(f.cex.xrp, Math.max(f.dex.xrp, f.cex.xrp, 1), 12);
    lines.push(this.boxLine(`  │ DEX: ${dexBar}  ${f.dex.xrp.toFixed(0)} XRP + $${f.dex.usd.toFixed(2)} USD`, W));
    lines.push(this.boxLine(`  │ CEX: ${cexBar}  ${f.cex.xrp.toFixed(0)} XRP + $${f.cex.usdt.toFixed(2)} USDT`, W));
    lines.push(this.boxLine(`  │ Total Value: ${C.bold}$${f.totalValueUsdt.toFixed(2)}${C.reset}`, W));
    lines.push(this.boxLine(`  └${'─'.repeat(Math.max(0, W - 5))}┘`, W));
    lines.push(this.boxLine('', W));

    // ─── PAPER TRADING ───
    if (s.paper) {
      const p = s.paper;
      const pnlColor = p.pnlUsdt >= 0 ? C.green : C.red;
      const pnlSign = p.pnlUsdt >= 0 ? '+' : '';
      lines.push(this.boxLine(`  ┌─ PAPER TRADING ($${flags.simBalance} sim) ${'─'.repeat(Math.max(0, W - 36))}┐`, W));
      lines.push(this.boxLine(`  │ Portfolio: $${p.portfolioUsdt.toFixed(2)} | P&L: ${pnlColor}${pnlSign}$${p.pnlUsdt.toFixed(2)} (${pnlSign}${p.pnlPct.toFixed(2)}%)${C.reset}`, W));
      lines.push(this.boxLine(`  │ Trades: ${p.totalTrades} | Win Rate: ${(p.winRate * 100).toFixed(0)}%`, W));
      lines.push(this.boxLine(`  └${'─'.repeat(Math.max(0, W - 5))}┘`, W));
      lines.push(this.boxLine('', W));
    }

    // ─── FEATURES ───
    lines.push(this.boxLine(`  ┌─ FEATURES ${'─'.repeat(Math.max(0, W - 16))}┐`, W));
    const feat = [
      `[${s.features.paperTrading ? '✓' : '✗'}] Paper`,
      `[${s.features.telegram ? '✓' : '✗'}] Telegram`,
      `[${s.features.dashboard ? '✓' : '✗'}] Web`,
      `[${s.features.cliUi ? '✓' : '✗'}] CLI`,
    ].join('  ');
    lines.push(this.boxLine(`  │ ${feat}`, W));
    lines.push(this.boxLine(`  └${'─'.repeat(Math.max(0, W - 5))}┘`, W));
    lines.push(this.boxLine('', W));

    // ─── LAST TRADES ───
    if (this.recentTrades.length > 0) {
      lines.push(this.boxLine(`  ┌─ LAST ${this.recentTrades.length} TRADES ${'─'.repeat(Math.max(0, W - 22))}┐`, W));
      for (const t of this.recentTrades) {
        const sideColor = t.side === 'BUY' ? C.green : C.red;
        const pnlStr = t.pnl !== 0 ? ` ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '';
        lines.push(this.boxLine(`  │ ${t.time} ${sideColor}${t.side}${C.reset} ${t.qty.toFixed(1)} XRP @ $${t.price.toFixed(4)} [${t.venue}]${pnlStr}`, W));
      }
      lines.push(this.boxLine(`  └${'─'.repeat(Math.max(0, W - 5))}┘`, W));
      lines.push(this.boxLine('', W));
    }

    // ─── WARNINGS ───
    if (s.warnings.length > 0) {
      for (const w of s.warnings) {
        lines.push(this.boxLine(`  ${C.yellow}⚠ ${w}${C.reset}`, W));
      }
      lines.push(this.boxLine('', W));
    }

    // ─── UPTIME ───
    lines.push(this.boxLine(`  ⏰ Uptime: ${this.formatUptime(s.uptimeSeconds)}`, W));

    lines.push(this.boxBottom(W));

    this.flush(lines);
  }

  // =====================================================================
  // HELPERS DE RENDERIZADO
  // =====================================================================

  private flush(lines: string[]): void {
    process.stdout.write(CLEAR_SCREEN + lines.join('\n') + '\n');
  }

  private boxTop(w: number): string {
    return `╔${'═'.repeat(w - 2)}╗`;
  }

  private boxMid(w: number): string {
    return `╠${'═'.repeat(w - 2)}╣`;
  }

  private boxBottom(w: number): string {
    return `╚${'═'.repeat(w - 2)}╝`;
  }

  private boxLine(content: string, _w: number): string {
    // No padding — dejar contenido libre (las secuencias ANSI dificultan el cálculo de ancho)
    return `║ ${content}`;
  }

  private progressBar(value: number, max: number, width: number): string {
    const filled = Math.round((value / max) * width);
    const empty = width - filled;
    return `${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset}`;
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${seconds % 60}s`;
  }
}
