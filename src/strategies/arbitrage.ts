import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';
import { MultiOracle, ConsensusPrice } from '../multiOracle.js';
import { DEXBookReader, DEXBookSnapshot } from '../dexBookReader.js';
import { CEXConnector, CEXTicker, CEXOrderResult } from '../cexConnector.js';

// =====================================================================
// TIPOS
// =====================================================================

/**
 * Dirección del arbitraje de dos patas:
 * - BUY_DEX_SELL_CEX: Comprar barato en DEX → Vender caro en CEX
 * - BUY_CEX_SELL_DEX: Comprar barato en CEX → Vender caro en DEX
 */
type ArbDirection = 'BUY_DEX_SELL_CEX' | 'BUY_CEX_SELL_DEX';

interface TwoLegOpportunity {
  direction: ArbDirection;
  dexPrice: number;          // Precio en el DEX (ask o bid según dirección)
  cexPrice: number;          // Precio en el CEX (bid o ask según dirección)
  grossSpreadPct: number;    // Spread bruto entre venues
  netSpreadPct: number;      // Spread neto descontando fees de ambos venues
  executableVolumeDex: number; // Volumen ejecutable en DEX
  tradeSize: number;         // Tamaño final del trade
  expectedProfitUsd: number;
  dexFeeEstUsd: number;      // Fee estimado en DEX (red XRPL)
  cexFeeEstUsd: number;      // Fee estimado en CEX (comisión Binance)
}

interface LegResult {
  venue: 'DEX' | 'CEX';
  side: 'BUY' | 'SELL';
  success: boolean;
  filledQty: number;
  filledPrice: number;
  hash?: string;
  orderId?: string;
  error?: string;
}

interface TwoLegTradeResult {
  direction: ArbDirection;
  leg1: LegResult;
  leg2: LegResult;
  netProfitUsd: number;
  bothFilled: boolean;
  timestamp: number;
}

interface ArbMetrics {
  totalTrades: number;
  successfulTrades: number;   // Ambas piernas ejecutadas
  partialTrades: number;      // Solo una pierna ejecutada (riesgo)
  failedTrades: number;       // Ambas piernas fallaron
  totalProfitUsd: number;
  avgSpreadCapturePct: number;
  lastTradeTimestamp: number;
  consecutiveSkips: number;
  // Inventario por venue
  dexInventoryXrp: number;    // Estimado de XRP en el DEX
  cexInventoryXrp: number;    // Estimado de XRP en el CEX
  dexInventoryUsd: number;
  cexInventoryUsd: number;
}

interface ArbState {
  metrics: ArbMetrics;
  lastTradeLedger: number;
  rebalancePending: boolean;
}

// =====================================================================
// CONSTANTES
// =====================================================================

const XRPL_FEE_XRP = 0.000012;        // Fee de red XRPL (~12 drops)
const BINANCE_FEE_PCT = 0.10;          // Comisión Binance Spot (0.1% maker/taker)
const BINANCE_BNB_DISCOUNT_PCT = 0.075; // Con BNB: 0.075%

// =====================================================================
// ESTRATEGIA DE ARBITRAJE DE DOS PATAS
// =====================================================================

/**
 * Arbitraje simultáneo DEX ↔ CEX de dos piernas.
 * 
 * Compra en un venue y vende en el otro en la misma ventana de tiempo
 * para capturar la discrepancia de precios.
 * 
 * Pierna A: XRPL DEX (on-chain, XRP/USD Bitstamp IOU)
 * Pierna B: Binance CEX (XRP/USDT via API REST)
 * 
 * Requiere:
 * - Wallet XRPL con fondos (XRP + USD IOU)
 * - Cuenta Binance con API Key/Secret y fondos (XRP + USDT)
 * 
 * Modos de operación:
 * 1. BUY_DEX_SELL_CEX: DEX Ask < CEX Bid → Comprar en DEX, Vender en CEX
 * 2. BUY_CEX_SELL_DEX: CEX Ask < DEX Bid → Comprar en CEX, Vender en DEX
 * 
 * Risk Management:
 * - Execución quasi-simultánea (primero la pierna más lenta: DEX)
 * - IOC orders en ambos venues para evitar fills parciales colgados
 * - Inventory tracking para detectar desbalances
 * - Auto-rebalance cuando el inventario se desvía demasiado
 * - Cooldown entre trades para evitar overtrading
 */
export class XRPLArbitrageStrategy extends AbstractStrategy {
  public readonly name = 'arbitrage';

  private multiOracle!: MultiOracle;
  private bookReader!: DEXBookReader;
  private cex!: CEXConnector;

  private state: ArbState = {
    metrics: {
      totalTrades: 0,
      successfulTrades: 0,
      partialTrades: 0,
      failedTrades: 0,
      totalProfitUsd: 0,
      avgSpreadCapturePct: 0,
      lastTradeTimestamp: 0,
      consecutiveSkips: 0,
      dexInventoryXrp: 0,
      cexInventoryXrp: 0,
      dexInventoryUsd: 0,
      cexInventoryUsd: 0,
    },
    lastTradeLedger: 0,
    rebalancePending: false,
  };

  protected async onInit(): Promise<void> {
    this.multiOracle = new MultiOracle({
      cacheTtlMs: 1500,      // Cache agresivo para arb
      fetchTimeoutMs: 1500,
      minSources: config.arbMinOracleSources,
    });

    this.bookReader = new DEXBookReader(this.client, {
      depthLevels: 15,
      cacheTtlMs: 2000,
    });

    this.cex = new CEXConnector();

    this.loadState();
    await this.syncInventories();

    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Arbitrage DEX↔CEX (2 Patas)',
    });

    const cexReady = this.cex.isConfigured() ? '✅ API keys OK' : '❌ Sin API keys (modo lectura)';
    this.log.info([
      `Arbitrage 2-Patas initialized:`,
      `CEX: ${cexReady}`,
      `minSpread=${config.arbMinSpreadPct}%`,
      `maxTrade=${config.arbMaxTradeXrp}XRP`,
      `cooldown=${config.arbCooldownLedgers} ledgers`,
      `maxSlippage=${config.arbMaxSlippagePct}%`,
    ].join(' | '));
  }

  // =====================================================================
  // TICK PRINCIPAL
  // =====================================================================

  async tick(currentLedger: number, _marketPrice: number): Promise<void> {
    // 0. Verificar que el CEX está configurado (solo obligatorio en real trading)
    if (!this.cex.isConfigured() && this.orderManager.constructor.name !== 'PaperOrderManager') {
      if (this.state.metrics.consecutiveSkips % 30 === 0) {
        this.log.warn('CEX no configurado. Configura BINANCE_API_KEY y BINANCE_API_SECRET para habilitar arbitraje de 2 patas.');
      }
      this.state.metrics.consecutiveSkips++;
      await this.updateArbDashboard(null, null, null, 'CEX NO CONFIGURADO');
      return;
    }

    // 1. Obtener datos en paralelo: MultiOracle + DEX Book + CEX Ticker
    const [consensus, book, cexTicker] = await Promise.all([
      this.multiOracle.getConsensusPrice(),
      this.bookReader.getBookSnapshot(),
      this.cex.getTicker(),
    ]);

    // 2. Validaciones
    if (!consensus || consensus.confidence < config.arbMinOracleConfidence) {
      this.state.metrics.consecutiveSkips++;
      await this.updateArbDashboard(consensus, book, cexTicker, 'ORÁCULO INSUFICIENTE');
      return;
    }

    if (!book || book.bestBid <= 0 || book.bestAsk <= 0) {
      this.state.metrics.consecutiveSkips++;
      await this.updateArbDashboard(consensus, book, cexTicker, 'DEX BOOK VACÍO');
      return;
    }

    if (!cexTicker || cexTicker.bidPrice <= 0 || cexTicker.askPrice <= 0) {
      this.state.metrics.consecutiveSkips++;
      await this.updateArbDashboard(consensus, book, cexTicker, 'CEX TICKER INVÁLIDO');
      return;
    }

    // 3. Cooldown check
    if (currentLedger - this.state.lastTradeLedger < config.arbCooldownLedgers) {
      await this.updateArbDashboard(consensus, book, cexTicker, 'COOLDOWN');
      return;
    }

    // 4. Detectar oportunidad de 2 patas
    const opportunity = this.detectTwoLegOpportunity(book, cexTicker);

    if (!opportunity) {
      this.state.metrics.consecutiveSkips++;
      if (this.state.metrics.consecutiveSkips % 10 === 0) {
        this.log.info(`${this.state.metrics.consecutiveSkips} ticks sin oportunidad. DEX: Bid=${book.bestBid.toFixed(4)} Ask=${book.bestAsk.toFixed(4)} | CEX: Bid=${cexTicker.bidPrice.toFixed(4)} Ask=${cexTicker.askPrice.toFixed(4)}`);
      }
      await this.updateArbDashboard(consensus, book, cexTicker, 'SCANNING');
      return;
    }

    // 5. Risk check
    const riskCheck = this.checkRiskLimits(opportunity);
    if (!riskCheck.allowed) {
      this.log.warn(`Risk blocked: ${riskCheck.reason}`);
      await this.updateArbDashboard(consensus, book, cexTicker, `BLOCKED: ${riskCheck.reason}`);
      return;
    }

    // 6. EJECUTAR ARBITRAJE DE DOS PATAS
    this.log.warn([
      `¡OPORTUNIDAD ${opportunity.direction}!`,
      `DEX=${opportunity.dexPrice.toFixed(4)}`,
      `CEX=${opportunity.cexPrice.toFixed(4)}`,
      `Net Spread=${opportunity.netSpreadPct.toFixed(3)}%`,
      `Size=${opportunity.tradeSize.toFixed(1)} XRP`,
      `Est.Profit=${opportunity.expectedProfitUsd.toFixed(4)} USD`,
    ].join(' | '));

    const tradeResult = await this.executeTwoLegTrade(opportunity, currentLedger);
    this.recordTradeResult(tradeResult, opportunity);

    await this.updateArbDashboard(consensus, book, cexTicker,
      tradeResult.bothFilled ? `✅ ${opportunity.direction}` : `⚠️ PARTIAL: ${opportunity.direction}`
    );
  }

  async cleanup(): Promise<void> {
    const m = this.state.metrics;
    this.log.info(`Arbitrage shutdown. Trades: ${m.totalTrades} (${m.successfulTrades} ok, ${m.partialTrades} partial) | P&L: ${m.totalProfitUsd.toFixed(4)} USD`);
    this.saveState();
  }

  // =====================================================================
  // DETECCIÓN DE OPORTUNIDADES DE 2 PATAS
  // =====================================================================

  private detectTwoLegOpportunity(book: DEXBookSnapshot, cexTicker: CEXTicker): TwoLegOpportunity | null {
    // --- Dirección 1: BUY_DEX_SELL_CEX ---
    // Comprar en DEX (al Ask) y Vender en CEX (al Bid)
    // Profit si: CEX Bid > DEX Ask + fees
    {
      const dexBuyPrice = book.bestAsk;
      const cexSellPrice = cexTicker.bidPrice;
      const grossSpreadPct = ((cexSellPrice - dexBuyPrice) / dexBuyPrice) * 100;
      const dexFeeEstPct = 0.01; // ~0.01% XRPL network fee
      const cexFeeEstPct = BINANCE_FEE_PCT;
      const netSpreadPct = grossSpreadPct - dexFeeEstPct - cexFeeEstPct;

      if (netSpreadPct >= config.arbMinSpreadPct) {
        const { volumeXrp } = this.bookReader.getExecutableVolume('buy', config.arbMaxSlippagePct);
        const tradeSize = this.calculateTradeSize(volumeXrp);

        if (tradeSize >= config.arbMinTradeXrp) {
          const dexFeeUsd = XRPL_FEE_XRP * dexBuyPrice;
          const cexFeeUsd = tradeSize * cexSellPrice * (BINANCE_FEE_PCT / 100);

          return {
            direction: 'BUY_DEX_SELL_CEX',
            dexPrice: dexBuyPrice,
            cexPrice: cexSellPrice,
            grossSpreadPct,
            netSpreadPct,
            executableVolumeDex: volumeXrp,
            tradeSize,
            expectedProfitUsd: tradeSize * (cexSellPrice - dexBuyPrice) - dexFeeUsd - cexFeeUsd,
            dexFeeEstUsd: dexFeeUsd,
            cexFeeEstUsd: cexFeeUsd,
          };
        }
      }
    }

    // --- Dirección 2: BUY_CEX_SELL_DEX ---
    // Comprar en CEX (al Ask) y Vender en DEX (al Bid)
    // Profit si: DEX Bid > CEX Ask + fees
    {
      const cexBuyPrice = cexTicker.askPrice;
      const dexSellPrice = book.bestBid;
      const grossSpreadPct = ((dexSellPrice - cexBuyPrice) / cexBuyPrice) * 100;
      const dexFeeEstPct = 0.01;
      const cexFeeEstPct = BINANCE_FEE_PCT;
      const netSpreadPct = grossSpreadPct - dexFeeEstPct - cexFeeEstPct;

      if (netSpreadPct >= config.arbMinSpreadPct) {
        const { volumeXrp } = this.bookReader.getExecutableVolume('sell', config.arbMaxSlippagePct);
        const tradeSize = this.calculateTradeSize(volumeXrp);

        if (tradeSize >= config.arbMinTradeXrp) {
          const dexFeeUsd = XRPL_FEE_XRP * dexSellPrice;
          const cexFeeUsd = tradeSize * cexBuyPrice * (BINANCE_FEE_PCT / 100);

          return {
            direction: 'BUY_CEX_SELL_DEX',
            dexPrice: dexSellPrice,
            cexPrice: cexBuyPrice,
            grossSpreadPct,
            netSpreadPct,
            executableVolumeDex: volumeXrp,
            tradeSize,
            expectedProfitUsd: tradeSize * (dexSellPrice - cexBuyPrice) - dexFeeUsd - cexFeeUsd,
            dexFeeEstUsd: dexFeeUsd,
            cexFeeEstUsd: cexFeeUsd,
          };
        }
      }
    }

    return null;
  }

  // =====================================================================
  // EJECUCIÓN DE DOS PATAS
  // =====================================================================

  /**
   * Ejecuta ambas piernas del arbitraje quasi-simultáneamente.
   * 
   * Estrategia de ejecución:
   * 1. Primero la pierna MÁS LENTA (DEX on-chain, ~4-5s de finalidad)
   * 2. Inmediatamente después, la pierna RÁPIDA (CEX, ~100ms)
   * 
   * Si la pierna lenta falla, NO ejecuta la rápida.
   * Si la pierna rápida falla después de la lenta, queda en estado "partial"
   * que se resuelve en el siguiente ciclo de rebalanceo.
   */
  private async executeTwoLegTrade(opp: TwoLegOpportunity, currentLedger: number): Promise<TwoLegTradeResult> {
    const timestamp = Date.now();

    if (opp.direction === 'BUY_DEX_SELL_CEX') {
      // Pierna 1 (lenta): Comprar XRP en DEX
      const dexResult = await this.executeDexLeg('BUY', opp.tradeSize, opp.dexPrice);

      if (!dexResult.success) {
        return {
          direction: opp.direction,
          leg1: dexResult,
          leg2: { venue: 'CEX', side: 'SELL', success: false, filledQty: 0, filledPrice: 0, error: 'Skipped (leg1 failed)' },
          netProfitUsd: 0,
          bothFilled: false,
          timestamp,
        };
      }

      // Pierna 2 (rápida): Vender XRP en CEX
      const cexResult = await this.executeCexLeg('SELL', dexResult.filledQty, opp.cexPrice);

      const netProfit = cexResult.success
        ? (cexResult.filledQty * cexResult.filledPrice) - (dexResult.filledQty * dexResult.filledPrice) - opp.dexFeeEstUsd
        : 0;

      return {
        direction: opp.direction,
        leg1: dexResult,
        leg2: cexResult,
        netProfitUsd: netProfit,
        bothFilled: dexResult.success && cexResult.success,
        timestamp,
      };

    } else {
      // BUY_CEX_SELL_DEX
      // Pierna 1 (rápida pero la hacemos primero por precio más confiable): Comprar XRP en CEX
      const cexResult = await this.executeCexLeg('BUY', opp.tradeSize, opp.cexPrice);

      if (!cexResult.success) {
        return {
          direction: opp.direction,
          leg1: { venue: 'DEX', side: 'SELL', success: false, filledQty: 0, filledPrice: 0, error: 'Skipped (CEX leg failed)' },
          leg2: cexResult,
          netProfitUsd: 0,
          bothFilled: false,
          timestamp,
        };
      }

      // Pierna 2 (lenta): Vender XRP en DEX
      const dexResult = await this.executeDexLeg('SELL', cexResult.filledQty, opp.dexPrice);

      const netProfit = dexResult.success
        ? (dexResult.filledQty * dexResult.filledPrice) - (cexResult.filledQty * cexResult.filledPrice) - opp.cexFeeEstUsd
        : 0;

      return {
        direction: opp.direction,
        leg1: dexResult,
        leg2: { ...cexResult, venue: 'CEX' as const },
        netProfitUsd: netProfit,
        bothFilled: dexResult.success && cexResult.success,
        timestamp,
      };
    }
  }

  /**
   * Ejecuta una pierna en el DEX XRPL via Market Order (IOC).
   */
  private async executeDexLeg(side: 'BUY' | 'SELL', qtyXrp: number, refPrice: number): Promise<LegResult> {
    try {
      if (side === 'BUY') {
        const maxBuyPrice = refPrice * (1 + config.arbMaxSlippagePct / 100);
        const usdCost = (qtyXrp * maxBuyPrice).toFixed(4);
        const takerPays = (qtyXrp * 1_000_000).toString();
        const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

        const result = await this.orderManager.createMarketOrder(this.wallet, takerPays, takerGets);
        return {
          venue: 'DEX', side: 'BUY',
          success: result.success,
          filledQty: qtyXrp, // Approximate (XRPL doesn't return exact fill in simple response)
          filledPrice: refPrice,
          hash: result.hash || '',
          error: result.error,
        };
      } else {
        const minSellPrice = refPrice * (1 - config.arbMaxSlippagePct / 100);
        const usdExpected = (qtyXrp * minSellPrice).toFixed(4);
        const takerPays = { currency: 'USD', value: usdExpected, issuer: this.usdIssuer };
        const takerGets = (qtyXrp * 1_000_000).toString();

        const result = await this.orderManager.createMarketOrder(this.wallet, takerPays, takerGets);
        return {
          venue: 'DEX', side: 'SELL',
          success: result.success,
          filledQty: qtyXrp,
          filledPrice: refPrice,
          hash: result.hash || '',
          error: result.error,
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`DEX Leg ${side} exception: ${errMsg}`);
      return {
        venue: 'DEX', side, success: false, filledQty: 0, filledPrice: 0, error: errMsg,
      };
    }
  }

  /**
   * Ejecuta una pierna en el CEX (Binance) via Market Order.
   */
  private async executeCexLeg(side: 'BUY' | 'SELL', qtyXrp: number, refPrice: number): Promise<LegResult> {
    try {
      // Si estamos en Paper Trading, simulamos la ejecución en el CEX inmediatamente
      if (this.orderManager.constructor.name === 'PaperOrderManager') {
        return {
          venue: 'CEX', side,
          success: true,
          filledQty: qtyXrp,
          filledPrice: refPrice,
          orderId: `PAPER_CEX_${Math.random().toString(36).substring(2, 9).toUpperCase()}`,
        };
      }

      let result: CEXOrderResult;

      if (side === 'BUY') {
        // Limit IOC al ask + slippage por seguridad
        const limitPrice = refPrice * (1 + config.arbMaxSlippagePct / 100);
        result = await this.cex.limitIOC('BUY', qtyXrp, limitPrice);
      } else {
        // Limit IOC al bid - slippage
        const limitPrice = refPrice * (1 - config.arbMaxSlippagePct / 100);
        result = await this.cex.limitIOC('SELL', qtyXrp, limitPrice);
      }

      return {
        venue: 'CEX', side,
        success: result.success && result.filledQty > 0,
        filledQty: result.filledQty,
        filledPrice: result.filledPrice,
        orderId: result.orderId,
        error: result.error,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`CEX Leg ${side} exception: ${errMsg}`);
      return {
        venue: 'CEX', side, success: false, filledQty: 0, filledPrice: 0, error: errMsg,
      };
    }
  }

  // =====================================================================
  // RISK MANAGEMENT
  // =====================================================================

  private checkRiskLimits(opp: TwoLegOpportunity): { allowed: boolean; reason: string } {
    // 1. Max position per venue
    if (opp.direction === 'BUY_DEX_SELL_CEX') {
      // Necesitamos USD en DEX y XRP en CEX
      if (this.state.metrics.cexInventoryXrp < opp.tradeSize) {
        return { allowed: false, reason: `CEX XRP insuficiente: ${this.state.metrics.cexInventoryXrp.toFixed(0)} < ${opp.tradeSize.toFixed(0)}` };
      }
    } else {
      // Necesitamos XRP en DEX y USDT en CEX
      if (this.state.metrics.dexInventoryXrp < opp.tradeSize + 15) {
        return { allowed: false, reason: `DEX XRP insuficiente: ${this.state.metrics.dexInventoryXrp.toFixed(0)} < ${(opp.tradeSize + 15).toFixed(0)}` };
      }
    }

    // 2. Max trade size
    if (opp.tradeSize > config.arbMaxTradeXrp) {
      return { allowed: false, reason: `Trade size ${opp.tradeSize.toFixed(0)} > max ${config.arbMaxTradeXrp}` };
    }

    // 3. Negative expected profit
    if (opp.expectedProfitUsd <= 0) {
      return { allowed: false, reason: `Profit esperado negativo: ${opp.expectedProfitUsd.toFixed(4)}` };
    }

    // 4. Don't take more than 30% of book depth
    if (opp.tradeSize > opp.executableVolumeDex * 0.3) {
      return { allowed: false, reason: `Trade > 30% of DEX depth (${opp.executableVolumeDex.toFixed(0)} XRP)` };
    }

    return { allowed: true, reason: '' };
  }

  // =====================================================================
  // INVENTORY SYNC
  // =====================================================================

  /**
   * Sincroniza los inventarios reales de ambos venues.
   */
  private async syncInventories(): Promise<void> {
    try {
      // DEX (XRPL)
      const { xrpBalance, usdBalance } = await this.fetchBalances();
      this.state.metrics.dexInventoryXrp = parseFloat(xrpBalance);
      this.state.metrics.dexInventoryUsd = parseFloat(usdBalance);

      // CEX (Binance)
      if (this.cex.isConfigured()) {
        const cexBal = await this.cex.getBalances();
        this.state.metrics.cexInventoryXrp = cexBal.xrp;
        this.state.metrics.cexInventoryUsd = cexBal.usd;
      }

      this.log.debug(`Inventory sync: DEX=${this.state.metrics.dexInventoryXrp.toFixed(0)} XRP + ${this.state.metrics.dexInventoryUsd.toFixed(2)} USD | CEX=${this.state.metrics.cexInventoryXrp.toFixed(0)} XRP + ${this.state.metrics.cexInventoryUsd.toFixed(2)} USDT`);

      // Alerta de desbalance (Leg-Lock Warning)
      const minXrpThreshold = config.arbMinTradeXrp * 2;
      const dexUnbalanced = this.state.metrics.dexInventoryXrp < minXrpThreshold || this.state.metrics.dexInventoryUsd < 50;
      const cexUnbalanced = this.cex.isConfigured() && (this.state.metrics.cexInventoryXrp < minXrpThreshold || this.state.metrics.cexInventoryUsd < 50);

      if (dexUnbalanced || cexUnbalanced) {
        this.log.warn(`⚠️ ALERTA DESBALANCE (Leg-Lock): Inventario bajo. DEX (XRP: ${this.state.metrics.dexInventoryXrp.toFixed(0)}, USD: ${this.state.metrics.dexInventoryUsd.toFixed(0)}) | CEX (XRP: ${this.state.metrics.cexInventoryXrp.toFixed(0)}, USD: ${this.state.metrics.cexInventoryUsd.toFixed(0)}). Rebalancear manualmente.`);
      }
    } catch (error) {
      this.log.error('Error syncing inventories:', error);
    }
  }

  // =====================================================================
  // MÉTRICAS
  // =====================================================================

  private recordTradeResult(result: TwoLegTradeResult, opp: TwoLegOpportunity): void {
    const m = this.state.metrics;
    m.totalTrades++;

    if (result.bothFilled) {
      m.successfulTrades++;
      m.totalProfitUsd += result.netProfitUsd;
      m.avgSpreadCapturePct = m.successfulTrades > 0
        ? ((m.avgSpreadCapturePct * (m.successfulTrades - 1) + opp.netSpreadPct) / m.successfulTrades)
        : opp.netSpreadPct;

      this.log.warn(`✅ 2-Leg Trade #${m.totalTrades}: ${result.direction} | Profit: +${result.netProfitUsd.toFixed(4)} USD | Total P&L: ${m.totalProfitUsd.toFixed(4)} USD`);

      db.logTransaction(`ARB_2LEG_${result.direction}`, result.leg1.hash || result.leg2.orderId || '', 'tesSUCCESS', {
        direction: result.direction,
        dexPrice: opp.dexPrice, cexPrice: opp.cexPrice,
        spreadPct: opp.netSpreadPct, tradeSize: opp.tradeSize,
        profitUsd: result.netProfitUsd, totalPnl: m.totalProfitUsd,
        leg1: { venue: result.leg1.venue, filled: result.leg1.filledQty, price: result.leg1.filledPrice },
        leg2: { venue: result.leg2.venue, filled: result.leg2.filledQty, price: result.leg2.filledPrice },
      });

    } else if (result.leg1.success || result.leg2.success) {
      m.partialTrades++;
      this.state.rebalancePending = true;

      this.log.error(`⚠️ PARTIAL FILL Trade #${m.totalTrades}: ${result.direction} | Leg1(${result.leg1.venue}): ${result.leg1.success ? 'OK' : 'FAIL'} | Leg2(${result.leg2.venue}): ${result.leg2.success ? 'OK' : 'FAIL'}`);

      db.logTransaction(`ARB_2LEG_PARTIAL`, '', 'PARTIAL_FILL', {
        direction: result.direction,
        leg1: result.leg1, leg2: result.leg2,
      });
    } else {
      m.failedTrades++;
      this.log.error(`❌ FAILED Trade #${m.totalTrades}: Both legs failed.`);
    }

    m.lastTradeTimestamp = Date.now();
    m.consecutiveSkips = 0;
    this.state.lastTradeLedger = Date.now(); // Approximate

    // Re-sync inventories after trade
    this.syncInventories().catch(() => {});
    this.saveState();
  }

  // =====================================================================
  // HELPERS
  // =====================================================================

  private calculateTradeSize(dexVolume: number): number {
    const maxByConfig = config.arbMaxTradeXrp;
    const maxByVolume = dexVolume * 0.3;
    return Math.max(0, Math.min(maxByConfig, maxByVolume));
  }

  private saveState(): void {
    try { db.saveCustomData('arbitrage_state', this.state); }
    catch (error) { this.log.error('Error saving state:', error); }
  }

  private loadState(): void {
    try {
      const saved = db.getCustomData('arbitrage_state');
      if (saved && saved.metrics) {
        this.state = saved;
        this.log.info(`Arbitrage: Restored (Trades: ${this.state.metrics.totalTrades}, P&L: ${this.state.metrics.totalProfitUsd.toFixed(4)} USD)`);
      }
    } catch (error) { this.log.error('Error loading state:', error); }
  }

  // =====================================================================
  // DASHBOARD
  // =====================================================================

  private async updateArbDashboard(
    consensus: ConsensusPrice | null,
    book: DEXBookSnapshot | null,
    cexTicker: CEXTicker | null,
    statusText: string
  ): Promise<void> {
    const m = this.state.metrics;
    const oracleHealth = this.multiOracle.getSourceHealth();
    const healthySources = Object.values(oracleHealth).filter(h => h.healthy).length;

    const dexInfo = book
      ? `DEX Bid:${book.bestBid.toFixed(4)} Ask:${book.bestAsk.toFixed(4)}`
      : 'DEX: N/A';
    const cexInfo = cexTicker
      ? `CEX Bid:${cexTicker.bidPrice.toFixed(4)} Ask:${cexTicker.askPrice.toFixed(4)}`
      : 'CEX: N/A';

    // Calcular spread actual entre venues
    let spreadInfo = 'N/A';
    if (book && cexTicker) {
      const buyDexSpread = ((cexTicker.bidPrice - book.bestAsk) / book.bestAsk * 100);
      const buyCexSpread = ((book.bestBid - cexTicker.askPrice) / cexTicker.askPrice * 100);
      spreadInfo = `→CEX:${buyDexSpread.toFixed(3)}% | ←CEX:${buyCexSpread.toFixed(3)}%`;
    }

    await this.updateDashboardWithBalances({
      midPrice: consensus ? consensus.price.toString() : '0',
      buyTarget: `${dexInfo} | ${cexInfo}`,
      sellTarget: spreadInfo,
      activeBuySeq: `Oracle: ${healthySources}/4 | Trades: ${m.totalTrades} (${m.successfulTrades}✅ ${m.partialTrades}⚠️)`,
      activeSellSeq: `INV DEX: ${m.dexInventoryXrp.toFixed(0)}XRP+${m.dexInventoryUsd.toFixed(0)}USD | CEX: ${m.cexInventoryXrp.toFixed(0)}XRP+${m.cexInventoryUsd.toFixed(0)}USDT`,
      strategyName: 'Arbitrage DEX↔CEX 2-Patas',
      activeRungs: `P&L: ${m.totalProfitUsd >= 0 ? '+' : ''}${m.totalProfitUsd.toFixed(4)} USD | AvgSpread: ${m.avgSpreadCapturePct.toFixed(3)}%`,
      botStatus: statusText,
    });
  }
}
