import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';


interface ActiveOrder {
  sequence: number;
  price: number;
  ledgerPlaced: number;
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
      // Leer el orderbook DEX real (XRP → USD: ¿a cuánto podemos vender XRP?)
      const sellBook = await this.client.request({
        command: 'book_offers',
        taker_pays: { currency: 'USD', issuer: this.usdIssuer },
        taker_gets: { currency: 'XRP' },
        limit: 10,
      });

      // Leer el orderbook DEX inverso (USD → XRP: ¿a cuánto podemos comprar XRP?)
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

      // Extraer mejor precio para vender XRP en el DEX
      if (sellOffers.length > 0) {
        const bestOffer = sellOffers[0];
        // TakerPays = USD que recibiríamos, TakerGets = XRP que daríamos
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
            // Precio objetivo: capturar 90% del edge (no ser 100% greedy)
            const targetPrice = midPrice + (dexSellPrice - midPrice) * edgeCapture;
            this.log.info(`🔴 [IOC] ¡Edge detectado! DEX=${dexSellPrice.toFixed(4)} Oracle=${midPrice.toFixed(4)} (+${(sellEdge * 100).toFixed(2)}%) → Target 90%: ${targetPrice.toFixed(4)} USD`);
            await this.executeIOCSell(targetPrice);
            stats.iocHits++;
            return;
          }
        }
      }

      // Extraer mejor precio para comprar XRP en el DEX
      if (buyOffers.length > 0) {
        const bestOffer = buyOffers[0];
        const xrpReceive = typeof bestOffer.TakerPays === 'string'
          ? parseInt(bestOffer.TakerPays) / 1_000_000
          : 0;
        const usdGive = typeof bestOffer.TakerGets === 'object'
          ? parseFloat(bestOffer.TakerGets.value)
          : 0;

        if (xrpReceive > 0) {
          const dexBuyPrice = usdGive / xrpReceive;
          const buyEdge = (midPrice - dexBuyPrice) / midPrice;

          this.log.debug(`🔴 [IOC] DEX buy price: ${dexBuyPrice.toFixed(4)} | Edge: ${(buyEdge * 100).toFixed(3)}%`);

          if (buyEdge > config.mmIocMinDexEdge) {
            // Precio objetivo: capturar 90% del edge (comprar un poco más caro que el DEX)
            const targetPrice = midPrice - (midPrice - dexBuyPrice) * edgeCapture;
            this.log.info(`🔴 [IOC] ¡Edge detectado! DEX=${dexBuyPrice.toFixed(4)} Oracle=${midPrice.toFixed(4)} (-${(buyEdge * 100).toFixed(2)}%) → Target 90%: ${targetPrice.toFixed(4)} USD`);
            await this.executeIOCBuy(targetPrice);
            stats.iocHits++;
            return;
          }
        }
      }

      this.log.info(`🔴 [IOC] Sin edge suficiente (min: ${(config.mmIocMinDexEdge * 100).toFixed(2)}%). Esperando...`);
    } catch (error) {
      this.log.error('🔴 [IOC] Error al leer orderbook DEX:', error);
    }
  }

  private async executeIOCSell(targetPrice: number): Promise<void> {
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
        db.logTransaction('IOC_VENTA', result.hash || '', 'tesSUCCESS', { price: targetPrice, amount: xrpAmount });
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
        db.logTransaction('IOC_COMPRA', result.hash || '', 'tesSUCCESS', { price: targetPrice, amount: xrpAmount });
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
    this.log.info('🎠 ═══ Resumen Carousel (vuelta completa) ═══');
    for (const mode of MODE_ORDER) {
      const s = this.modeStats[mode];
      const extra = mode === CarouselMode.AGGRESSIVE_IOC
        ? ` | IOC: ${s.iocHits}/${s.iocAttempts} hits`
        : '';
      this.log.info(`  ${MODE_LABELS[mode]}: fills=${s.fills}, fees=${s.feesSpentDrops}drops, ticks=${s.ticksActive}, rots=${s.rotations}${extra}`);
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
        this.log.info(`¡Orden de COMPRA (Seq: ${this.activeBuy.sequence}) fue ejecutada (FILLED)!`);
        this.modeStats[this.carouselMode].fills++;
        db.logTransaction('COMPRA_FILLED', '', 'FILLED', {
          sequence: this.activeBuy.sequence,
          price: this.activeBuy.price,
          mode: this.carouselMode,
        });
        this.activeBuy = null;
      }

      if (this.activeSell && !activeSequences.has(this.activeSell.sequence)) {
        this.log.info(`¡Orden de VENTA (Seq: ${this.activeSell.sequence}) fue ejecutada (FILLED)!`);
        this.modeStats[this.carouselMode].fills++;
        db.logTransaction('VENTA_FILLED', '', 'FILLED', {
          sequence: this.activeSell.sequence,
          price: this.activeSell.price,
          mode: this.carouselMode,
        });
        this.activeSell = null;
      }
    } catch (error) {
      this.log.error('Error al verificar fills (account_offers):', error);
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
        };
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
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
        };
        this.modeStats[this.carouselMode].feesSpentDrops += EST_FEE_DROPS_PER_TX;
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
