import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';
import { PnLTracker, VerifiedFill } from '../pnlTracker.js';


interface ActiveOrder {
  sequence: number;
  price: number;
  ledgerPlaced: number;
  hash?: string;  // TX hash para verificación post-fill
}

// =====================================================================
// CAROUSEL MODE SYSTEM
// =====================================================================

enum CarouselMode {
  TIGHT_PASSIVE = 'TIGHT_PASSIVE',
  STANDARD_PASSIVE = 'STANDARD_PASSIVE',
  AGGRESSIVE_IOC = 'AGGRESSIVE_IOC',
  REST_OBSERVE = 'REST_OBSERVE',
}

const MODE_LABELS: Record<CarouselMode, string> = {
  [CarouselMode.TIGHT_PASSIVE]: '🔵 Tight Passive',
  [CarouselMode.STANDARD_PASSIVE]: '🟢 Standard Passive',
  [CarouselMode.AGGRESSIVE_IOC]: '🔴 Aggressive IOC',
  [CarouselMode.REST_OBSERVE]: '⚪ Rest/Observe',
};

const MODE_ORDER: CarouselMode[] = [
  CarouselMode.TIGHT_PASSIVE,
  CarouselMode.STANDARD_PASSIVE,
  CarouselMode.AGGRESSIVE_IOC,
  CarouselMode.REST_OBSERVE,
];

interface ModeStats {
  fills: number;
  feesSpentDrops: number;
  ticksActive: number;
  rotations: number;
  iocAttempts: number;
  iocHits: number;
}

// Transacciones por roundtrip completo: 2 OfferCancel + 2 OfferCreate
const TXS_PER_ROUNDTRIP = 4;
// TTL del cache de fees de red (5 minutos)
const FEE_CACHE_TTL_MS = 5 * 60 * 1000;
// Drops por transacción (estimación para stats)
const EST_FEE_DROPS_PER_TX = 12;

export class XRPLMarketMakerStrategy extends AbstractStrategy {
  public readonly name = 'market_maker';

  // === Parámetros de la estrategia (desde config / env vars) ===
  private baseSpread = config.mmBaseSpread;
  private minSpread = config.mmMinSpread;
  private maxSpread = config.mmMaxSpread;
  private orderAmountXRP = config.mmOrderAmountXrp.toString();
  private priceDeviationThreshold = config.mmPriceDeviationThreshold;
  private cooldownLedgers = config.mmCooldownLedgers;
  private maxPositionXRP = config.mmMaxPositionXrp;
  private targetPositionXRP = config.mmTargetPositionXrp;
  private minProfitMargin = config.mmMinProfitMargin;

  // === Estado de órdenes activas ===
  private activeBuy: ActiveOrder | null = null;
  private activeSell: ActiveOrder | null = null;

  // === Estado de tracking ===
  private lastPrice: number = 0;
  private lastReplaceLedger: number = 0;
  private currentLedger: number = 0;

  // === Fee-Aware Spread Floor (adaptativo) ===
  private cachedFeeDrops: number = 12;
  private feeCacheTimestamp: number = 0;
  private lastFeeFloorLog: number = 0;

  // === Carousel State ===
  private carouselMode: CarouselMode = MODE_ORDER[0];
  private carouselModeIndex: number = 0;
  private modeStartLedger: number = 0;
  private modeStats: Record<CarouselMode, ModeStats> = {
    [CarouselMode.TIGHT_PASSIVE]: { fills: 0, feesSpentDrops: 0, ticksActive: 0, rotations: 0, iocAttempts: 0, iocHits: 0 },
    [CarouselMode.STANDARD_PASSIVE]: { fills: 0, feesSpentDrops: 0, ticksActive: 0, rotations: 0, iocAttempts: 0, iocHits: 0 },
    [CarouselMode.AGGRESSIVE_IOC]: { fills: 0, feesSpentDrops: 0, ticksActive: 0, rotations: 0, iocAttempts: 0, iocHits: 0 },
    [CarouselMode.REST_OBSERVE]: { fills: 0, feesSpentDrops: 0, ticksActive: 0, rotations: 0, iocAttempts: 0, iocHits: 0 },
  };
  private totalRotations: number = 0;

  // === P&L Tracker ===
  private pnlTracker = new PnLTracker();

  // === Production Safety ===
  private sessionStartTime = Date.now();
  private sessionFeesDrops = 0;            // Fees acumulados esta sesión
  private isPaused = false;                // Circuit breaker activado
  private pauseReason = '';
  private lastBalanceCheck = 0;            // Timestamp del último balance check
  private cachedXrpBalance = 0;
  private readonly BALANCE_CHECK_INTERVAL_MS = 30_000; // Verificar balance cada 30s
  private readonly MAX_SESSION_FEE_DROPS = config.mmMaxSessionFeeDrops;
  private readonly MAX_LOSS_USD = config.mmMaxLossUsd;
  private readonly MIN_XRP_OPERATIONAL = config.minXrpReserveBuffer + 10; // Reserva + buffer

  protected async onInit(): Promise<void> {
    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Market Maker (Carousel MM)'
    });
    // Pre-cargar fee de la red al inicio
    await this.refreshNetworkFee();
    this.log.info(`🎠 Carousel MM iniciado. Modo: ${MODE_LABELS[this.carouselMode]}`);
  }

  // =====================================================================
  // TICK PRINCIPAL — DESPACHO POR MODO
  // =====================================================================

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    this.currentLedger = currentLedger;

    // Inicializar ledger de inicio del modo si es el primer tick
    if (this.modeStartLedger === 0) {
      this.modeStartLedger = currentLedger;
    }

    // ── CIRCUIT BREAKER: verificar si Helena debe pausarse ──
    if (this.isPaused) {
      // Log reducido cada 30 ledgers (~90s) para no spamear
      if (currentLedger % 30 === 0) {
        this.log.warn(`🛑 [PAUSED] ${this.pauseReason}. Cancelando órdenes y esperando...`);
      }
      await this.cancelActiveOrders();
      return;
    }

    // ── SAFETY CHECKS ──
    await this.runSafetyChecks(marketPrice);
    if (this.isPaused) return;

    // 1. Verificar si la ventana del modo actual expiró → rotar
    const modeDuration = this.getModeDuration(this.carouselMode);
    if (currentLedger - this.modeStartLedger >= modeDuration) {
      await this.rotateMode(marketPrice);
    }

    // 2. Detectar fills (aplica a todos los modos con órdenes activas)
    await this.checkForFills();

    // 3. Tracking por modo
    this.modeStats[this.carouselMode].ticksActive++;

    // 4. Despachar al modo activo
    switch (this.carouselMode) {
      case CarouselMode.TIGHT_PASSIVE:
        await this.tickTightPassive(marketPrice);
        break;
      case CarouselMode.STANDARD_PASSIVE:
        await this.tickStandardPassive(marketPrice);
        break;
      case CarouselMode.AGGRESSIVE_IOC:
        await this.tickAggressiveIOC(marketPrice);
        break;
      case CarouselMode.REST_OBSERVE:
        await this.tickRestObserve(marketPrice);
        break;
    }

    // 5. Actualizar tracking
    this.lastPrice = marketPrice;
  }

  // =====================================================================
  // PRODUCTION SAFETY — Stop Loss, Circuit Breaker, Balance Check
  // =====================================================================

  private async runSafetyChecks(marketPrice: number): Promise<void> {
    // 1. Circuit Breaker: fees excesivos
    if (this.sessionFeesDrops > this.MAX_SESSION_FEE_DROPS) {
      this.pauseBot(`Fees acumulados (${this.sessionFeesDrops} drops) superan límite (${this.MAX_SESSION_FEE_DROPS} drops)`);
      return;
    }

    // 2. Stop Loss: P&L negativo más allá del umbral
    const pnl = this.pnlTracker.getSummary();
    if (pnl.totalNetProfitUsd < -this.MAX_LOSS_USD) {
      this.pauseBot(`Stop-loss activado: P&L neto $${pnl.totalNetProfitUsd.toFixed(4)} supera pérdida máxima -$${this.MAX_LOSS_USD.toFixed(2)}`);
      return;
    }

    // 3. Balance check: verificar reserva XRP cada 30s
    const now = Date.now();
    if (now - this.lastBalanceCheck > this.BALANCE_CHECK_INTERVAL_MS) {
      this.lastBalanceCheck = now;
      try {
        const balStr = await this.client.getXrpBalance(this.wallet.address);
        this.cachedXrpBalance = typeof balStr === 'string' ? parseFloat(balStr) : balStr;

        if (this.cachedXrpBalance < this.MIN_XRP_OPERATIONAL) {
          this.pauseBot(`XRP balance (${this.cachedXrpBalance.toFixed(2)}) bajo mínimo operacional (${this.MIN_XRP_OPERATIONAL.toFixed(2)} XRP)`);
          return;
        }
      } catch {
        this.log.warn('⚠️ No se pudo verificar balance XRP, continuando con cache.');
      }
    }
  }

  private pauseBot(reason: string): void {
    if (!this.isPaused) {
      this.isPaused = true;
      this.pauseReason = reason;
      this.log.error(`🛑 CIRCUIT BREAKER: ${reason}`);
      this.log.error('🛑 Helena pausada. Reiniciar manualmente para reactivar.');
    }
  }

  async cleanup(): Promise<void> {
    this.log.info('Limpiando órdenes activas de Market Maker...');
    await this.cancelActiveOrders();
    this.logCarouselSummary();
  }

  // =====================================================================
  // MODO 1: TIGHT PASSIVE — Spread apretado, más probabilidad de fill
  // =====================================================================

  private async tickTightPassive(marketPrice: number): Promise<void> {
    const midPrice = marketPrice;
    const bestBid = midPrice * 0.999;
    const bestAsk = midPrice * 1.001;

    this.log.info(`🔵 [TIGHT] Precios: Bid=${bestBid.toFixed(4)} | Ask=${bestAsk.toFixed(4)} | Medio=${midPrice.toFixed(4)} USD`);

    // Cooldown
    if (this.currentLedger - this.lastReplaceLedger < this.cooldownLedgers) {
      return;
    }

    // Spread tight fijo (0.3% default) + fee floor
    const tightSpread = config.mmTightSpread;
    const feeFloor = await this.getBreakevenSpread(midPrice);
    const effectiveSpread = Math.max(tightSpread, feeFloor);

    const inventoryBias = await this.calculateInventoryBias();
    const targetBuyPrice = midPrice * (1 - effectiveSpread / 2 + inventoryBias);
    const targetSellPrice = midPrice * (1 + effectiveSpread / 2 + inventoryBias);

    this.log.info(`🔵 [TIGHT] Objetivos: Compra=${targetBuyPrice.toFixed(4)} | Venta=${targetSellPrice.toFixed(4)} USD (spread: ${(effectiveSpread * 100).toFixed(2)}%)`);

    const needsReplace = this.shouldReplaceOrders(midPrice, targetBuyPrice, targetSellPrice);
    const hasMissingOrders = this.activeBuy === null || this.activeSell === null;

    if (needsReplace || hasMissingOrders) {
      await this.cancelActiveOrders();
      if (this.activeBuy === null) await this.placeBuyOrder(targetBuyPrice);
      if (this.activeSell === null) await this.placeSellOrder(targetSellPrice);
      this.lastReplaceLedger = this.currentLedger;
    }

    await this.updateDashboard(midPrice, targetBuyPrice, targetSellPrice, '🔵 Tight Passive');
  }

  // =====================================================================
  // MODO 2: STANDARD PASSIVE — Lógica original con spread dinámico
  // =====================================================================

  private async tickStandardPassive(marketPrice: number): Promise<void> {
    const midPrice = marketPrice;
    const bestBid = midPrice * 0.999;
    const bestAsk = midPrice * 1.001;

    this.log.info(`🟢 [STD] Precios: Bid=${bestBid.toFixed(4)} | Ask=${bestAsk.toFixed(4)} | Medio=${midPrice.toFixed(4)} USD`);

    // Cooldown
    if (this.currentLedger - this.lastReplaceLedger < this.cooldownLedgers) {
      return;
    }

    // Spread dinámico con volatilidad + fee floor
    const dynamicSpread = await this.calculateDynamicSpread(midPrice);
    const inventoryBias = await this.calculateInventoryBias();
    const targetBuyPrice = midPrice * (1 - dynamicSpread / 2 + inventoryBias);
    const targetSellPrice = midPrice * (1 + dynamicSpread / 2 + inventoryBias);

    this.log.info(`🟢 [STD] Objetivos: Compra=${targetBuyPrice.toFixed(4)} | Venta=${targetSellPrice.toFixed(4)} USD`);

    const needsReplace = this.shouldReplaceOrders(midPrice, targetBuyPrice, targetSellPrice);
    const hasMissingOrders = this.activeBuy === null || this.activeSell === null;

    if (needsReplace || hasMissingOrders) {
      await this.cancelActiveOrders();
      if (this.activeBuy === null) await this.placeBuyOrder(targetBuyPrice);
      if (this.activeSell === null) await this.placeSellOrder(targetSellPrice);
      this.lastReplaceLedger = this.currentLedger;
    }

    await this.updateDashboard(midPrice, targetBuyPrice, targetSellPrice, '🟢 Standard Passive');
  }

  // =====================================================================
  // MODO 3: AGGRESSIVE IOC — Cruzar contra liquidez DEX si hay edge
  // =====================================================================

  private async tickAggressiveIOC(marketPrice: number): Promise<void> {
    const midPrice = marketPrice;
    this.log.info(`🔴 [IOC] Oracle mid: ${midPrice.toFixed(4)} USD — Escaneando DEX orderbook...`);

    const stats = this.modeStats[CarouselMode.AGGRESSIVE_IOC];
    stats.iocAttempts++;

    try {
      // ── SELL SIDE: ¿A cuánto podemos VENDER XRP? ──
      // book_offers: muestra ofertas de gente que QUIERE COMPRAR XRP (pagan USD)
      // taker_gets = lo que nosotros daríamos (XRP), taker_pays = lo que recibiríamos (USD)
      const sellBook = await this.client.request({
        command: 'book_offers',
        taker_pays: { currency: 'USD', issuer: this.usdIssuer },
        taker_gets: { currency: 'XRP' },
        limit: 10,
      });

      // ── BUY SIDE: ¿A cuánto podemos COMPRAR XRP? ──
      // book_offers: muestra ofertas de gente que QUIERE VENDER XRP (piden USD)
      // taker_gets = lo que nosotros daríamos (USD), taker_pays = lo que recibiríamos (XRP)
      const buyBook = await this.client.request({
        command: 'book_offers',
        taker_pays: { currency: 'XRP' },
        taker_gets: { currency: 'USD', issuer: this.usdIssuer },
        limit: 10,
      });

      const sellOffers = sellBook.result.offers || [];
      const buyOffers = buyBook.result.offers || [];

      // Factor de captura adaptativo: se ajusta según el hit rate del IOC
      const edgeCapture = this.getAdaptiveEdgeCapture();

      let acted = false;

      // ── Evaluar VENTA: DEX paga MÁS que oracle → vender XRP caro ──
      if (sellOffers.length > 0) {
        const bestOffer = sellOffers[0];
        const usdReceive = typeof bestOffer.TakerPays === 'object'
          ? parseFloat(bestOffer.TakerPays.value)
          : 0;
        const xrpGive = typeof bestOffer.TakerGets === 'string'
          ? parseInt(bestOffer.TakerGets) / 1_000_000
          : 0;

        if (xrpGive > 0) {
          const dexSellPrice = usdReceive / xrpGive;
          const sellEdge = (dexSellPrice - midPrice) / midPrice;

          this.log.debug(`🔴 [IOC] DEX sell price: ${dexSellPrice.toFixed(4)} | Edge: ${(sellEdge * 100).toFixed(3)}%`);

          if (sellEdge > config.mmIocMinDexEdge) {
            const targetPrice = midPrice + (dexSellPrice - midPrice) * edgeCapture;
            this.log.info(`🔴 [IOC] ¡SELL Edge! DEX=${dexSellPrice.toFixed(4)} Oracle=${midPrice.toFixed(4)} (+${(sellEdge * 100).toFixed(2)}%) → Target ${(edgeCapture*100).toFixed(0)}%: ${targetPrice.toFixed(4)} USD`);
            await this.executeIOCSell(targetPrice);
            stats.iocHits++;
            acted = true;
          }
        }
      }

      // ── Evaluar COMPRA: DEX vende MÁS BARATO que oracle → comprar XRP barato ──
      if (!acted && buyOffers.length > 0) {
        const bestOffer = buyOffers[0];
        // En buyBook: TakerGets = USD que alguien ofrece, TakerPays = XRP que pide
        // Nosotros seríamos el taker: damos USD, recibimos XRP
        const usdAsk = typeof bestOffer.TakerGets === 'object'
          ? parseFloat(bestOffer.TakerGets.value)
          : 0;
        const xrpGet = typeof bestOffer.TakerPays === 'string'
          ? parseInt(bestOffer.TakerPays) / 1_000_000
          : 0;

        if (xrpGet > 0 && usdAsk > 0) {
          // Precio al que alguien vende XRP en el DEX
          const dexBuyPrice = usdAsk / xrpGet;
          // Edge positivo = DEX es más barato que oracle (oportunidad de compra)
          const buyEdge = (midPrice - dexBuyPrice) / midPrice;

          this.log.debug(`🔴 [IOC] DEX buy price: ${dexBuyPrice.toFixed(4)} | Edge: ${(buyEdge * 100).toFixed(3)}%`);

          if (buyEdge > config.mmIocMinDexEdge) {
            // Comprar un poco más caro que el DEX (capturar X% del descuento)
            const targetPrice = midPrice - (midPrice - dexBuyPrice) * edgeCapture;
            this.log.info(`🔴 [IOC] ¡BUY Edge! DEX=${dexBuyPrice.toFixed(4)} Oracle=${midPrice.toFixed(4)} (-${(buyEdge * 100).toFixed(2)}%) → Target ${(edgeCapture*100).toFixed(0)}%: ${targetPrice.toFixed(4)} USD`);
            await this.executeIOCBuy(targetPrice);
            stats.iocHits++;
            acted = true;
          }
        }
      }

      if (!acted) {
        this.log.info(`🔴 [IOC] Sin edge suficiente (min: ${(config.mmIocMinDexEdge * 100).toFixed(2)}%). Esperando...`);
      }
    } catch (error) {
      this.log.error('🔴 [IOC] Error al leer orderbook DEX:', error);
    }
  }

  private async executeIOCSell(targetPrice: number): Promise<void> {
    // Balance check rápido antes de operar
    if (this.cachedXrpBalance > 0 && this.cachedXrpBalance < this.MIN_XRP_OPERATIONAL + parseFloat(this.orderAmountXRP)) {
      this.log.warn(`🔴 [IOC] Balance insuficiente (${this.cachedXrpBalance.toFixed(2)} XRP). Saltando SELL.`);
      return;
    }

    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * targetPrice).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };
    const takerGets = (xrpAmount * 1000000).toString();

    this.log.info(`🔴 [IOC] Ejecutando VENTA IOC: ${xrpAmount} XRP a ${targetPrice.toFixed(4)} USD (Retorno: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createMarketOrder(this.wallet, takerPays, takerGets);
      if (result.success) {
        this.modeStats[CarouselMode.AGGRESSIVE_IOC].fills++;
        this.modeStats[CarouselMode.AGGRESSIVE_IOC].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('IOC_VENTA', result.hash || '', 'tesSUCCESS', { price: targetPrice, amount: xrpAmount });
        // Registrar en P&L tracker
        this.pnlTracker.recordFill({
          side: 'SELL',
          price: targetPrice,
          amount: xrpAmount,
          usdAmount: parseFloat(usdValue),
          feeDrops: EST_FEE_DROPS_PER_TX,
          hash: result.hash || '',
          timestamp: new Date().toISOString(),
          mode: CarouselMode.AGGRESSIVE_IOC,
        });
      }
    } catch (error) {
      this.log.error('🔴 [IOC] Error al ejecutar IOC sell:', error);
    }
  }

  private async executeIOCBuy(targetPrice: number): Promise<void> {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * targetPrice).toFixed(4);

    const takerPays = (xrpAmount * 1000000).toString();
    const takerGets = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };

    this.log.info(`🔴 [IOC] Ejecutando COMPRA IOC: ${xrpAmount} XRP a ${targetPrice.toFixed(4)} USD (Costo: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createMarketOrder(this.wallet, takerPays, takerGets);
      if (result.success) {
        this.modeStats[CarouselMode.AGGRESSIVE_IOC].fills++;
        this.modeStats[CarouselMode.AGGRESSIVE_IOC].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('IOC_COMPRA', result.hash || '', 'tesSUCCESS', { price: targetPrice, amount: xrpAmount });
        // Registrar en P&L tracker
        this.pnlTracker.recordFill({
          side: 'BUY',
          price: targetPrice,
          amount: xrpAmount,
          usdAmount: parseFloat(usdValue),
          feeDrops: EST_FEE_DROPS_PER_TX,
          hash: result.hash || '',
          timestamp: new Date().toISOString(),
          mode: CarouselMode.AGGRESSIVE_IOC,
        });
      }
    } catch (error) {
      this.log.error('🔴 [IOC] Error al ejecutar IOC buy:', error);
    }
  }

  // =====================================================================
  // MODO 4: REST/OBSERVE — Sin órdenes, solo monitorear
  // =====================================================================

  private async tickRestObserve(marketPrice: number): Promise<void> {
    const midPrice = marketPrice;
    this.log.info(`⚪ [REST] Observando mercado. Mid: ${midPrice.toFixed(4)} USD. Sin órdenes activas.`);

    // Aprovechar el descanso para refrescar el cache de fees
    if (Date.now() - this.feeCacheTimestamp > FEE_CACHE_TTL_MS) {
      await this.refreshNetworkFee();
    }
  }

  // =====================================================================
  // CAROUSEL ROTATION
  // =====================================================================

  private getModeDuration(mode: CarouselMode): number {
    switch (mode) {
      case CarouselMode.TIGHT_PASSIVE:
        return config.mmCarouselTightLedgers;
      case CarouselMode.STANDARD_PASSIVE:
        return config.mmCarouselStandardLedgers;
      case CarouselMode.AGGRESSIVE_IOC:
        return config.mmCarouselIocLedgers;
      case CarouselMode.REST_OBSERVE:
        return this.getAdaptiveRestDuration();
    }
  }

  private getAdaptiveRestDuration(): number {
    if (this.lastPrice === 0) return config.mmCarouselRestLedgers;

    // No tenemos el precio actual aquí, usamos lastPrice como proxy
    // La volatilidad se mide entre ticks anteriores
    const volatility = this.lastPrice > 0 ? 0.001 : 0; // placeholder, se actualiza en rotación
    
    // Usar el historial de fills para decidir: si hubo fills recientes, descanso corto
    const recentFills = this.modeStats[CarouselMode.TIGHT_PASSIVE].fills
      + this.modeStats[CarouselMode.STANDARD_PASSIVE].fills
      + this.modeStats[CarouselMode.AGGRESSIVE_IOC].fills;

    if (recentFills > 0 && this.totalRotations > 0) {
      const fillRate = recentFills / this.totalRotations;
      if (fillRate > 0.3) return config.mmCarouselRestLedgers;       // Mucha actividad: descanso mínimo
      if (fillRate > 0.1) return Math.ceil((config.mmCarouselRestLedgers + config.mmCarouselRestMaxLedgers) / 2);
    }

    return config.mmCarouselRestMaxLedgers; // Mercado muerto: descanso máximo
  }

  /**
   * Ajusta el % del edge que intentamos capturar según el hit rate del IOC.
   * 
   * Si estamos teniendo muchos fills → ser más greedy (capturar 95%)
   * Si estamos teniendo pocos fills → ser menos greedy (capturar 70%) para no perder oportunidades
   * 
   * Rangos:
   *   Hit rate > 30%  → 0.95 (mercado fácil, ser agresivo)
   *   Hit rate 15-30%  → 0.90 (balanced)
   *   Hit rate 5-15%  → 0.80 (mercado difícil, aceptar menos)
   *   Hit rate < 5%   → 0.70 (mercado muerto, tomar lo que haya)
   */
  private getAdaptiveEdgeCapture(): number {
    const stats = this.modeStats[CarouselMode.AGGRESSIVE_IOC];
    
    // Necesitamos al menos 5 scans para tener una muestra significativa
    if (stats.iocAttempts < 5) return 0.90; // Default conservador al inicio

    const hitRate = stats.iocHits / stats.iocAttempts;

    let capture: number;
    let tier: string;

    if (hitRate > 0.30) {
      capture = 0.95;
      tier = 'GREEDY (95%)';
    } else if (hitRate > 0.15) {
      capture = 0.90;
      tier = 'BALANCED (90%)';
    } else if (hitRate > 0.05) {
      capture = 0.80;
      tier = 'FLEXIBLE (80%)';
    } else {
      capture = 0.70;
      tier = 'GENEROUS (70%)';
    }

    this.log.debug(`🔴 [IOC] Edge capture adaptativo: ${tier} | Hit rate: ${(hitRate * 100).toFixed(1)}% (${stats.iocHits}/${stats.iocAttempts})`);
    return capture;
  }

  private async rotateMode(marketPrice: number): Promise<void> {
    const prevMode = this.carouselMode;
    const prevStats = this.modeStats[prevMode];
    const ticksInMode = this.currentLedger - this.modeStartLedger;

    // Log stats del modo que termina
    this.log.info(`🎠 Fin de ${MODE_LABELS[prevMode]} (${ticksInMode} ledgers) — Fills: ${prevStats.fills}, Fees: ${prevStats.feesSpentDrops} drops`);

    // Cancelar todas las órdenes activas (clean slate para el siguiente modo)
    await this.cancelActiveOrders();

    // Rotar al siguiente modo
    this.carouselModeIndex = (this.carouselModeIndex + 1) % MODE_ORDER.length;
    this.carouselMode = MODE_ORDER[this.carouselModeIndex];
    this.modeStartLedger = this.currentLedger;
    this.modeStats[this.carouselMode].rotations++;
    this.totalRotations++;

    // Reset cooldown para que el nuevo modo pueda operar inmediatamente
    this.lastReplaceLedger = 0;

    this.log.info(`🎠 → Entrando ${MODE_LABELS[this.carouselMode]} (ventana: ${this.getModeDuration(this.carouselMode)} ledgers) [Rotación #${this.totalRotations}]`);

    // Log resumen acumulado cada vuelta completa (cada 4 rotaciones)
    if (this.totalRotations % MODE_ORDER.length === 0) {
      this.logCarouselSummary();
    }
  }

  private logCarouselSummary(): void {
    const vuelta = Math.floor(this.totalRotations / MODE_ORDER.length);
    this.log.info(`🎠 ═══ Carousel #${vuelta} ══════════════════════════════`);

    let totalFees = 0;
    let totalFills = 0;
    for (const mode of MODE_ORDER) {
      const s = this.modeStats[mode];
      totalFees += s.feesSpentDrops;
      totalFills += s.fills;
      const label = MODE_LABELS[mode].padEnd(20);
      const iocExtra = mode === CarouselMode.AGGRESSIVE_IOC
        ? ` | hit: ${s.iocHits}/${s.iocAttempts} (${s.iocAttempts > 0 ? ((s.iocHits/s.iocAttempts)*100).toFixed(0) : 0}%)`
        : '';
      this.log.info(`  ${label} fills: ${String(s.fills).padStart(3)} | fees: ${String(s.feesSpentDrops).padStart(5)} drops | ticks: ${String(s.ticksActive).padStart(4)}${iocExtra}`);
    }
    this.log.info(`  ${'─'.repeat(55)}`);
    this.log.info(`  TOTALES              fills: ${String(totalFills).padStart(3)} | fees: ${String(totalFees).padStart(5)} drops ($${(totalFees / 1_000_000 * (this.lastPrice || 1)).toFixed(4)} USD)`);

    // P&L Report
    const pnlLines = this.pnlTracker.formatSummaryLog();
    for (const line of pnlLines) {
      this.log.info(line);
    }
    this.log.info('🎠 ═══════════════════════════════════════════');
  }

  // =====================================================================
  // DETECCIÓN DE FILLS
  // =====================================================================

  private async checkForFills() {
    // Solo verificar si hay órdenes activas
    if (!this.activeBuy && !this.activeSell) return;

    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address,
      });
      
      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      if (this.activeBuy && !activeSequences.has(this.activeBuy.sequence)) {
        const verified = await this.verifyFillViaTx(this.activeBuy, 'BUY');
        if (verified) {
          this.log.info(`✅ [FILL VERIFICADO] COMPRA: ${verified.amount.toFixed(2)} XRP a $${verified.price.toFixed(4)} (fee: ${verified.feeDrops} drops)`);
          this.modeStats[this.carouselMode].fills++;
          this.pnlTracker.recordFill(verified);
          db.logTransaction('COMPRA_FILLED', verified.hash, 'FILLED', {
            sequence: this.activeBuy.sequence,
            executedPrice: verified.price,
            executedAmount: verified.amount,
            feeDrops: verified.feeDrops,
            mode: this.carouselMode,
          });
        } else {
          this.log.warn(`⚠️ Orden de COMPRA (Seq: ${this.activeBuy.sequence}) desapareció pero NO se verificó fill. Posible cancelación/expiración.`);
        }
        this.activeBuy = null;
      }

      if (this.activeSell && !activeSequences.has(this.activeSell.sequence)) {
        const verified = await this.verifyFillViaTx(this.activeSell, 'SELL');
        if (verified) {
          this.log.info(`✅ [FILL VERIFICADO] VENTA: ${verified.amount.toFixed(2)} XRP a $${verified.price.toFixed(4)} (fee: ${verified.feeDrops} drops)`);
          this.modeStats[this.carouselMode].fills++;
          this.pnlTracker.recordFill(verified);
          db.logTransaction('VENTA_FILLED', verified.hash, 'FILLED', {
            sequence: this.activeSell.sequence,
            executedPrice: verified.price,
            executedAmount: verified.amount,
            feeDrops: verified.feeDrops,
            mode: this.carouselMode,
          });
        } else {
          this.log.warn(`⚠️ Orden de VENTA (Seq: ${this.activeSell.sequence}) desapareció pero NO se verificó fill. Posible cancelación/expiración.`);
        }
        this.activeSell = null;
      }
    } catch (error) {
      this.log.error('Error al verificar fills (account_offers):', error);
    }
  }

  /**
   * Verifica un fill consultando la TX real en el ledger.
   * Retorna datos del fill verificado o null si no hubo intercambio.
   */
  private async verifyFillViaTx(order: ActiveOrder, side: 'BUY' | 'SELL'): Promise<VerifiedFill | null> {
    if (!order.hash) {
      // Sin hash, no podemos verificar → asumir fill con precio de la orden (legacy)
      return {
        side,
        price: order.price,
        amount: parseFloat(this.orderAmountXRP),
        usdAmount: order.price * parseFloat(this.orderAmountXRP),
        feeDrops: EST_FEE_DROPS_PER_TX,
        hash: '',
        timestamp: new Date().toISOString(),
        mode: this.carouselMode,
      };
    }

    try {
      const txResponse = await this.client.request({
        command: 'tx',
        transaction: order.hash,
      });

      const tx = txResponse.result as any;
      if (!tx || !tx.meta || typeof tx.meta === 'string') {
        return null;
      }

      const meta = tx.meta;

      // Si TransactionResult no es tesSUCCESS, no hubo fill
      if (meta.TransactionResult !== 'tesSUCCESS') {
        return null;
      }

      // Extraer balance changes del meta
      const feeDrops = parseInt(tx.Fee || '12', 10);

      // Buscar cambios de balance en AffectedNodes
      let xrpChange = 0;
      let usdChange = 0;

      for (const node of meta.AffectedNodes || []) {
        const modified = node.ModifiedNode || node.DeletedNode;
        if (!modified) continue;

        // Cambios en AccountRoot (XRP balance)
        if (modified.LedgerEntryType === 'AccountRoot') {
          const finalFields = modified.FinalFields;
          const prevFields = modified.PreviousFields;
          if (finalFields?.Account === this.wallet.address && prevFields?.Balance) {
            const prev = parseInt(prevFields.Balance, 10);
            const final = parseInt(finalFields.Balance, 10);
            xrpChange = (final - prev) / 1_000_000;
          }
        }

        // Cambios en RippleState (USD/IOU balance)
        if (modified.LedgerEntryType === 'RippleState') {
          const finalFields = modified.FinalFields;
          const prevFields = modified.PreviousFields;
          if (finalFields?.Balance && prevFields?.Balance) {
            const prevBal = parseFloat(prevFields.Balance.value || '0');
            const finalBal = parseFloat(finalFields.Balance.value || '0');
            const change = finalBal - prevBal;
            if (Math.abs(change) > 0.0001) {
              usdChange = change;
            }
          }
        }
      }

      // Determinar si hubo un intercambio real
      const absXrp = Math.abs(xrpChange) - (feeDrops / 1_000_000); // Restar fee del cambio XRP
      const absUsd = Math.abs(usdChange);

      if (absXrp < 0.001 && absUsd < 0.001) {
        // No hubo intercambio significativo
        return null;
      }

      // Calcular precio de ejecución real
      const executedAmount = absXrp > 0.001 ? absXrp : parseFloat(this.orderAmountXRP);
      const executedUsd = absUsd > 0.001 ? absUsd : order.price * executedAmount;
      const executedPrice = executedAmount > 0 ? executedUsd / executedAmount : order.price;

      return {
        side,
        price: executedPrice,
        amount: executedAmount,
        usdAmount: executedUsd,
        feeDrops,
        hash: order.hash,
        timestamp: new Date().toISOString(),
        mode: this.carouselMode,
      };
    } catch (error) {
      this.log.warn(`No se pudo verificar TX ${order.hash}, asumiendo fill al precio de la orden.`);
      return {
        side,
        price: order.price,
        amount: parseFloat(this.orderAmountXRP),
        usdAmount: order.price * parseFloat(this.orderAmountXRP),
        feeDrops: EST_FEE_DROPS_PER_TX,
        hash: order.hash,
        timestamp: new Date().toISOString(),
        mode: this.carouselMode,
      };
    }
  }

  // =====================================================================
  // DECISIÓN DE CANCEL/REPLACE
  // =====================================================================

  private shouldReplaceOrders(currentPrice: number, _targetBuy: number, _targetSell: number): boolean {
    if (this.currentLedger - this.lastReplaceLedger < this.cooldownLedgers) {
      return false;
    }

    if (this.activeBuy === null && this.activeSell === null) {
      return false;
    }

    if (this.activeBuy) {
      const buyDeviation = Math.abs(currentPrice - this.activeBuy.price) / this.activeBuy.price;
      if (buyDeviation > this.priceDeviationThreshold) {
        this.log.info(`Desviación de compra: ${(buyDeviation * 100).toFixed(2)}% > ${(this.priceDeviationThreshold * 100).toFixed(2)}% → Recolocando`);
        return true;
      }
    }

    if (this.activeSell) {
      const sellDeviation = Math.abs(currentPrice - this.activeSell.price) / this.activeSell.price;
      if (sellDeviation > this.priceDeviationThreshold) {
        this.log.info(`Desviación de venta: ${(sellDeviation * 100).toFixed(2)}% > ${(this.priceDeviationThreshold * 100).toFixed(2)}% → Recolocando`);
        return true;
      }
    }

    return false;
  }

  // =====================================================================
  // SPREAD DINÁMICO (usado por Standard Passive)
  // =====================================================================

  private async calculateDynamicSpread(currentPrice: number): Promise<number> {
    if (this.lastPrice === 0) {
      return this.baseSpread;
    }

    const priceChange = Math.abs(currentPrice - this.lastPrice) / this.lastPrice;
    const volatilityAdjustment = priceChange * 10;
    const dynamicSpread = this.baseSpread + volatilityAdjustment;

    // Clamp al rango [minSpread, maxSpread] tradicional
    const clampedSpread = Math.max(this.minSpread, Math.min(this.maxSpread, dynamicSpread));

    // Fee-Aware Floor: garantizar que el spread cubre costos reales + margen
    const feeFloor = await this.getBreakevenSpread(currentPrice);
    if (feeFloor > clampedSpread) {
      if (this.currentLedger - this.lastFeeFloorLog >= 30) {
        this.log.warn(`Fee floor activado: spread mínimo rentable ${(feeFloor * 100).toFixed(4)}% > spread calculado ${(clampedSpread * 100).toFixed(4)}%. Elevando spread.`);
        this.lastFeeFloorLog = this.currentLedger;
      }
    }

    return Math.max(clampedSpread, feeFloor);
  }

  // =====================================================================
  // FEE-AWARE SPREAD FLOOR (adaptativo a fees de red)
  // =====================================================================

  private async refreshNetworkFee(): Promise<void> {
    try {
      const serverInfo = await this.client.request({ command: 'server_info' });
      const loadFee = serverInfo.result.info.validated_ledger?.base_fee_xrp;
      if (loadFee !== undefined) {
        this.cachedFeeDrops = Math.ceil(loadFee * 1_000_000);
        this.feeCacheTimestamp = Date.now();
        this.log.debug(`Fee de red actualizado: ${this.cachedFeeDrops} drops (${loadFee} XRP)`);
      }
    } catch (error) {
      this.log.warn(`No se pudo actualizar fee de red, usando cache: ${this.cachedFeeDrops} drops`);
    }
  }

  private async getBreakevenSpread(midPrice: number): Promise<number> {
    if (Date.now() - this.feeCacheTimestamp > FEE_CACHE_TTL_MS) {
      await this.refreshNetworkFee();
    }

    const feeXrp = this.cachedFeeDrops / 1_000_000;
    const orderAmount = parseFloat(this.orderAmountXRP);
    const orderValueUsd = orderAmount * midPrice;
    const roundtripCostUsd = feeXrp * TXS_PER_ROUNDTRIP * midPrice;
    const breakevenSpread = (roundtripCostUsd / orderValueUsd) * this.minProfitMargin;

    return breakevenSpread;
  }

  // =====================================================================
  // GESTIÓN DE INVENTARIO
  // =====================================================================

  private async calculateInventoryBias(): Promise<number> {
    try {
      const xrpBalanceNum = await this.client.getXrpBalance(this.wallet.address);
      const xrpNum = typeof xrpBalanceNum === 'string' ? parseFloat(xrpBalanceNum) : xrpBalanceNum;

      const deviation = (xrpNum - this.targetPositionXRP) / this.maxPositionXRP;
      const bias = deviation * 0.005;

      return Math.max(-0.005, Math.min(0.005, bias));
    } catch {
      return 0;
    }
  }

  // =====================================================================
  // GESTIÓN DE ÓRDENES
  // =====================================================================

  private async cancelActiveOrders() {
    if (this.activeBuy) {
      this.log.info(`Cancelando orden de compra activa (Seq: ${this.activeBuy.sequence})...`);
      try {
        const result = await this.orderManager.cancelOrder(this.wallet, this.activeBuy.sequence);
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('CANCELAR_COMPRA', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), {
          sequence: this.activeBuy.sequence
        });
      } catch (error) {
        this.log.error('Error al cancelar orden de compra:', error);
      }
      this.activeBuy = null;
    }

    if (this.activeSell) {
      this.log.info(`Cancelando orden de venta activa (Seq: ${this.activeSell.sequence})...`);
      try {
        const result = await this.orderManager.cancelOrder(this.wallet, this.activeSell.sequence);
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('CANCELAR_VENTA', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), {
          sequence: this.activeSell.sequence
        });
      } catch (error) {
        this.log.error('Error al cancelar orden de venta:', error);
      }
      this.activeSell = null;
    }
  }

  private async placeBuyOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = (xrpAmount * 1000000).toString();
    const takerGets = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };

    this.log.info(`Colocando COMPRA MM: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Costo: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (result.success && result.sequence !== undefined) {
        this.activeBuy = {
          sequence: result.sequence,
          price: priceUsd,
          ledgerPlaced: this.currentLedger,
          hash: result.hash || undefined,
        };
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('COMPRA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount, mode: this.carouselMode });
      } else {
        db.logTransaction('COMPRA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
      }
    } catch (error) {
      this.log.error('Excepción al colocar orden de compra:', error);
    }
  }

  private async placeSellOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };
    const takerGets = (xrpAmount * 1000000).toString();

    this.log.info(`Colocando VENTA MM: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Retorno: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (result.success && result.sequence !== undefined) {
        this.activeSell = {
          sequence: result.sequence,
          price: priceUsd,
          ledgerPlaced: this.currentLedger,
          hash: result.hash || undefined,
        };
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
        this.sessionFeesDrops += EST_FEE_DROPS_PER_TX;
        db.logTransaction('VENTA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount, mode: this.carouselMode });
      } else {
        db.logTransaction('VENTA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
      }
    } catch (error) {
      this.log.error('Excepción al colocar orden de venta:', error);
    }
  }

  // =====================================================================
  // DASHBOARD HELPER
  // =====================================================================

  private async updateDashboard(midPrice: number, buyTarget: number, sellTarget: number, modeLabel: string) {
    await this.updateDashboardWithBalances({
      midPrice: midPrice.toString(),
      buyTarget: buyTarget.toString(),
      sellTarget: sellTarget.toString(),
      activeBuySeq: this.activeBuy !== null ? this.activeBuy.sequence.toString() : 'Ninguna',
      activeSellSeq: this.activeSell !== null ? this.activeSell.sequence.toString() : 'Ninguna',
      strategyName: `Market Maker (${modeLabel})`,
      activeRungs: `Rot #${this.totalRotations}`,
      botStatus: `Modo: ${modeLabel}`
    });
  }
}
