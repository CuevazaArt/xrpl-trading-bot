import { createLogger } from './logger.js';
import { config } from './config.js';
import type { HealthSnapshot } from './healthMonitor.js';

const log = createLogger('Telegram');

// =====================================================================
// TELEGRAM NOTIFIER
// =====================================================================

/**
 * Envía notificaciones al chat de Telegram configurado vía Bot API.
 * 
 * Requiere:
 * - TELEGRAM_BOT_TOKEN: Token del bot (de @BotFather)
 * - TELEGRAM_CHAT_ID: ID del chat/grupo donde enviar mensajes
 * 
 * Usa fetch nativo (Node 18+), sin dependencias externas.
 */
export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private readonly baseUrl: string;
  private lastCriticalAlertAt: number = 0;
  private readonly criticalAlertCooldownMs: number = 60_000; // 1 minuto entre alertas críticas

  constructor() {
    this.botToken = config.telegramBotToken;
    this.chatId = config.telegramChatId;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;

    if (!this.botToken || !this.chatId) {
      log.warn('⚠️ TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados. Notificaciones desactivadas.');
    }
  }

  isConfigured(): boolean {
    return !!(this.botToken && this.chatId);
  }

  // =====================================================================
  // MENSAJES PREDEFINIDOS
  // =====================================================================

  /**
   * Envía el reporte periódico de salud.
   */
  async sendHealthReport(snapshot: HealthSnapshot): Promise<void> {
    const uptime = this.formatUptime(snapshot.uptimeSeconds);
    const statusIcon = snapshot.online ? '✅' : '🔴';
    const priceStr = snapshot.oracle.xrpPrice > 0 ? `$${snapshot.oracle.xrpPrice.toFixed(4)}` : 'N/A';

    let message = `🤖 *Pecunator Bot — Health Report*\n━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `${statusIcon} ${snapshot.online ? 'Online' : 'OFFLINE'} | Ledger #${snapshot.ledgerHeight.toLocaleString()}\n`;
    message += `📊 Estrategia: \`${snapshot.strategy}\`\n`;
    message += `💰 Precio XRP: ${priceStr} (${snapshot.oracle.activeSources}/${snapshot.oracle.totalSources} fuentes)\n\n`;

    // Fondos
    const f = snapshot.funds;
    message += `📦 *Distribución de Fondos:*\n`;
    message += `  DEX: ${f.dex.xrp.toFixed(0)} XRP + $${f.dex.usd.toFixed(2)} USD\n`;
    message += `  CEX: ${f.cex.xrp.toFixed(0)} XRP + $${f.cex.usdt.toFixed(2)} USDT\n`;
    message += `  Total: *$${f.totalValueUsdt.toFixed(2)}*\n`;

    // Paper trading
    if (snapshot.paper) {
      const p = snapshot.paper;
      const pnlSign = p.pnlUsdt >= 0 ? '+' : '';
      message += `\n📈 *Paper Trading:* ${pnlSign}$${p.pnlUsdt.toFixed(2)} (${pnlSign}${p.pnlPct.toFixed(2)}%)\n`;
      message += `  Trades: ${p.totalTrades} | Win Rate: ${(p.winRate * 100).toFixed(0)}%\n`;
    }

    // Warnings
    if (snapshot.warnings.length > 0) {
      message += `\n⚠️ *Warnings:*\n`;
      snapshot.warnings.forEach(w => { message += `  • ${w}\n`; });
    }

    // Features
    const feat: string[] = [];
    if (snapshot.features.paperTrading) feat.push('Paper');
    if (snapshot.features.telegram) feat.push('Telegram');
    if (snapshot.features.cliUi) feat.push('CLI');
    if (snapshot.features.dashboard) feat.push('Web');
    message += `\n🔧 Features: ${feat.join(', ') || 'ninguna'}`;
    message += `\n⏰ Uptime: ${uptime}`;

    await this.sendMessage(message);
  }

  /**
   * Notifica que un trade fue ejecutado (real o paper).
   */
  async sendTradeNotification(
    side: 'BUY' | 'SELL',
    qtyXrp: number,
    price: number,
    venue: string,
    profitUsdt?: number,
    isPaper: boolean = false
  ): Promise<void> {
    const icon = side === 'BUY' ? '🟢' : '🔴';
    const mode = isPaper ? ' (PAPER)' : '';
    let message = `${icon} *Trade ${side}${mode}*\n`;
    message += `${qtyXrp.toFixed(1)} XRP @ $${price.toFixed(4)} [${venue}]\n`;
    if (profitUsdt !== undefined) {
      const sign = profitUsdt >= 0 ? '+' : '';
      message += `P&L: ${sign}$${profitUsdt.toFixed(4)}`;
    }

    await this.sendMessage(message);
  }

  /**
   * Notifica startup del bot.
   */
  async sendStartup(strategy: string, features: string[]): Promise<void> {
    let message = `🚀 *Pecunator Bot — STARTED*\n━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 Estrategia: \`${strategy}\`\n`;
    message += `🔧 Features: ${features.join(', ') || 'ninguna'}\n`;
    message += `⏰ ${new Date().toLocaleString()}`;

    await this.sendMessage(message);
  }

  /**
   * Notifica shutdown del bot.
   */
  async sendShutdown(uptimeSeconds: number): Promise<void> {
    const uptime = this.formatUptime(uptimeSeconds);
    await this.sendMessage(`🛑 *Pecunator Bot — STOPPED*\nUptime: ${uptime}`);
  }

  /**
   * Envía una alerta de warning.
   */
  async sendWarning(warning: string): Promise<void> {
    await this.sendMessage(`⚠️ *Warning:* ${warning}`);
  }

  /**
   * Envía una alerta CRÍTICA que requiere atención inmediata.
   * Rate limited: máximo 1 alerta por minuto para evitar spam en cascada.
   * 
   * Usar para: uncaughtException, oracle total failure, balance peligrosamente bajo.
   */
  async sendCriticalAlert(message: string): Promise<void> {
    const now = Date.now();
    if ((now - this.lastCriticalAlertAt) < this.criticalAlertCooldownMs) {
      log.warn(`Alerta crítica suprimida por cooldown (${Math.ceil((this.criticalAlertCooldownMs - (now - this.lastCriticalAlertAt)) / 1000)}s restantes).`);
      return;
    }
    this.lastCriticalAlertAt = now;

    const text = `🚨🚨 *ALERTA CRÍTICA — Helena*\n━━━━━━━━━━━━━━━━━━━━━\n${message}\n\n⏰ ${new Date().toISOString()}`;
    await this.sendMessage(text);
  }

  // =====================================================================
  // CORE
  // =====================================================================

  /**
   * Envía un mensaje de texto vía Telegram Bot API.
   * Usa parse_mode=Markdown para formato.
   */
  private async sendMessage(text: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const data: any = await response.json();
        log.error(`Telegram API error: ${data.description || response.status}`);
        return false;
      }

      return true;
    } catch (error) {
      log.error('Error enviando mensaje a Telegram:', error);
      return false;
    }
  }

  private formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}
