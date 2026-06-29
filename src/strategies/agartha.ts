import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface AgarthaState {
  epochId: string;
  positionSize: number;
  entryPrice: number;
  peakPrice: number;
  isTrailingActive: boolean;
  buySequence?: number;
  buyLimitPrice?: number;
  ledgersInPosition: number;
  
  // Re-quoting locales de salida
  sellSequence?: number;
  sellLimitPrice?: number;
  sellOrderTimestamp?: number;
  hasReordered60s?: boolean;
  hasReordered5m?: boolean;
  status: 'ACTIVE' | 'STALE_EXIT';
}

export class XRPLAgarthaStrategy extends AbstractStrategy {
  public readonly name = 'agartha';
  private state: AgarthaState = {
    epochId: '',
    positionSize: 0,
    entryPrice: 0,
    peakPrice: 0,
    isTrailingActive: false,
    ledgersInPosition: 0,
    status: 'ACTIVE'
  };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Agartha Moonshot Trailing'
    });
    this.log.info(`Agartha initialized: asset=${config.agarthaAssetCode}, qty=${config.agarthaBuyQty} units, trailing_stop=${config.agarthaTrailingStopPct}%, activation_profit=${config.agarthaActivationProfitPct}%`);
  }

  async tick(currentLedger: number, marketPriceXrp: number): Promise<void> {
    // 1. Obtener precio del activo volátil desde el oráculo CEX de alta velocidad (Binance)
    const assetPrice = await this.fetchAssetPrice();
    if (assetPrice <= 0) {
      this.log.warn(`Agartha: No se pudo obtener cotización para ${config.agarthaAssetCode}. Omitiendo tick.`);
      return;
    }

    await this.syncBuyLimitOrder(assetPrice);
    await this.syncExitLimitOrder(assetPrice);

    // Si no hay posición activa ni orden de compra pendiente, ejecutar compra inicial
    if (this.state.positionSize === 0 && !this.state.buySequence) {
      this.log.info(`Agartha: Buscando entrada en ${config.agarthaAssetCode} a precio $${assetPrice.toFixed(4)} USD...`);
      await this.placeEntry(assetPrice);
      return;
    }

    // Gestionar posición abierta
    if (this.state.positionSize > 0) {
      // Si ya hay un proceso de salida activo (orden de venta enviada), evaluar timeouts de re-quote
      if (this.state.sellSequence) {
        await this.evaluateExitTimeouts(assetPrice);
        await this.updateAgarthaDashboard(assetPrice);
        return;
      }

      this.state.ledgersInPosition++;

      // Time Stop de seguridad (solo si max holding ledgers > 0, de lo contrario corre indefinidamente)
      if (config.agarthaMaxHoldingLedgers > 0 && this.state.ledgersInPosition >= config.agarthaMaxHoldingLedgers) {
        this.log.warn(`Agartha Time Stop: Posición retenida durante ${this.state.ledgersInPosition} ledgers. Iniciando liquidación...`);
        await this.startExit(assetPrice, 'TIME_STOP');
        return;
      }

      this.state.peakPrice = Math.max(this.state.peakPrice, assetPrice);

      // Evaluar activación de Trailing Stop
      if (!this.state.isTrailingActive) {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        if (this.state.peakPrice >= activationThreshold) {
          this.state.isTrailingActive = true;
          this.log.warn(`¡Agartha Trailing Stop ACTIVADO! PeakPrice($${this.state.peakPrice.toFixed(4)}) >= Target($${activationThreshold.toFixed(4)})`);
        }
      }

      // Evaluar salida de Trailing Stop
      if (this.state.isTrailingActive) {
        const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
        const distanceToFloorPct = ((assetPrice - trailingFloor) / assetPrice) * 100;
        this.log.info(`Agartha Trailing [${config.agarthaAssetCode}]: Peak=$${this.state.peakPrice.toFixed(4)} | Piso=$${trailingFloor.toFixed(4)} | Precio=$${assetPrice.toFixed(4)} | Dist=${distanceToFloorPct.toFixed(2)}%`);

        if (assetPrice <= trailingFloor) {
          this.log.warn(`¡Agartha Trailing Stop gatillado! Iniciando liquidación en ${config.agarthaAssetCode}...`);
          await this.startExit(assetPrice, 'TRAILING_EXIT');
          return;
        }
      } else {
        const activationThreshold = this.state.entryPrice * (1 + config.agarthaActivationProfitPct / 100);
        this.log.info(`Agartha Position [${config.agarthaAssetCode}]: Entrada=$${this.state.entryPrice.toFixed(4)} | Pico=$${this.state.peakPrice.toFixed(4)} | TargetAct=$${activationThreshold.toFixed(4)}`);
      }

      this.saveState();
      await this.updateAgarthaDashboard(assetPrice);
    }
  }

  async cleanup(): Promise<void> {
    this.log.info('Cleanup: Agartha manteniendo estructuras de trailing activas.');
  }

  private async syncBuyLimitOrder(currentPrice: number) {
    if (!this.state.buySequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.buySequence)) {
        const fillPrice = this.state.buyLimitPrice || currentPrice;
        const buyQty = config.agarthaBuyQty;
        
        this.log.info(`Agartha: Entry-Limit llenado! (Seq: ${this.state.buySequence}, Precio: ${fillPrice})`);
        
        this.state.positionSize = buyQty;
        this.state.entryPrice = fillPrice;
        this.state.peakPrice = fillPrice;
        this.state.isTrailingActive = false;
        this.state.buySequence = undefined;
        this.state.buyLimitPrice = undefined;
        this.state.ledgersInPosition = 0;
        this.state.status = 'ACTIVE';
        this.state.epochId = `epoch_agartha_${Date.now()}`;
        
        db.logTransaction('AGARTHA_LIMIT_FILLED', '', 'FILLED', {
          asset: config.agarthaAssetCode,
          entryPrice: fillPrice,
          qty: buyQty
        });
        
        this.saveState();
      }
    } catch (error) {
      this.log.error('Agartha: Error consultando órdenes límite activas:', error);
    }
  }

  private async syncExitLimitOrder(currentPrice: number) {
    if (!this.state.sellSequence) return;
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      if (!activeSequences.has(this.state.sellSequence)) {
        const fillPrice = this.state.sellLimitPrice || currentPrice;
        this.log.info(`Agartha: Exit-Limit llenado! (Seq: ${this.state.sellSequence}, Precio: ${fillPrice})`);
        
        db.logTransaction('AGARTHA_LIQUIDATED', '', 'FILLED', {
          asset: config.agarthaAssetCode,
          reason: 'EXIT_ORDER_FILLED',
          entryPrice: this.state.entryPrice,
          exitPrice: fillPrice,
          qty: this.state.positionSize,
          profitUsd: this.state.positionSize * (fillPrice - this.state.entryPrice)
        });

        this.resetState();
        this.saveState();
      }
    } catch (error) {
      this.log.error('Agartha: Error al sincronizar orden de salida:', error);
    }
  }

  private async placeEntry(marketPrice: number) {
    const buyQty = config.agarthaBuyQty;

    if (config.agarthaEntryLimitOffsetPct === 0) {
      const maxBuyPrice = marketPrice * 1.01;
      const usdCost = (buyQty * maxBuyPrice).toFixed(4);
      const takerPays = { currency: config.agarthaAssetCode, value: buyQty.toFixed(4), issuer: config.agarthaAssetIssuer };
      const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

      this.log.info(`Agartha: Comprando ${config.agarthaAssetCode} a mercado (Límite: $${maxBuyPrice.toFixed(4)} USD)`);
      try {
        const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays as any, takerGets as any);
        if (buyResult.success && buyResult.sequence) {
          this.state.positionSize = buyQty;
          this.state.entryPrice = marketPrice;
          this.state.peakPrice = marketPrice;
          this.state.isTrailingActive = false;
          this.state.ledgersInPosition = 0;
          this.state.status = 'ACTIVE';
          this.state.epochId = `epoch_agartha_${Date.now()}`;
          this.saveState();
          
          db.logTransaction('AGARTHA_BUY', buyResult.hash || '', 'tesSUCCESS', {
            asset: config.agarthaAssetCode,
            price: marketPrice,
            amount: buyQty
          });
          await this.updateAgarthaDashboard(marketPrice);
        }
      } catch (error) {
        this.log.error('Agartha: Falló la compra a mercado de entrada:', error);
      }
    } else {
      const limitPrice = parseFloat((marketPrice * (1 - config.agarthaEntryLimitOffsetPct / 100)).toFixed(4));
      const usdCost = (buyQty * limitPrice).toFixed(4);
      const takerPays = { currency: config.agarthaAssetCode, value: buyQty.toFixed(4), issuer: config.agarthaAssetIssuer };
      const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

      this.log.info(`Agartha: Colocando orden límite de compra por ${buyQty.toFixed(4)} ${config.agarthaAssetCode} a $${limitPrice.toFixed(4)} USD`);
      try {
        const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays as any, takerGets as any);
        if (buyResult.success && buyResult.sequence !== undefined) {
          this.state.buySequence = buyResult.sequence;
          this.state.buyLimitPrice = limitPrice;
          this.saveState();
          db.logTransaction('AGARTHA_ENTRY_LIMIT', buyResult.hash || '', 'tesSUCCESS', {
            asset: config.agarthaAssetCode,
            price: limitPrice,
            amount: buyQty
          });
        } else {
          this.log.error('Agartha: Error al colocar orden límite de entrada:', buyResult.error);
        }
      } catch (error) {
        this.log.error('Agartha: Excepción colocando orden límite de entrada:', error);
      }
    }
  }

  private async startExit(currentPrice: number, reason: string) {
    const qty = this.state.positionSize;
    const sellPrice = currentPrice * 0.99; // Límite inicial agresivo
    const usdCost = (qty * sellPrice).toFixed(4);
    const takerPays = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };
    const takerGets = { currency: config.agarthaAssetCode, value: qty.toFixed(4), issuer: config.agarthaAssetIssuer };

    this.log.warn(`Agartha: Colocando orden de salida de ${qty.toFixed(4)} ${config.agarthaAssetCode} a $${sellPrice.toFixed(4)} USD (${reason})`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays as any, takerGets as any);
      if (sellResult.success && sellResult.sequence !== undefined) {
        this.state.sellSequence = sellResult.sequence;
        this.state.sellLimitPrice = sellPrice;
        this.state.sellOrderTimestamp = Date.now();
        this.state.hasReordered60s = false;
        this.state.hasReordered5m = false;
        this.state.status = 'ACTIVE';
        this.saveState();

        db.logTransaction('AGARTHA_EXIT_ORDER', sellResult.hash || '', 'tesSUCCESS', {
          asset: config.agarthaAssetCode,
          reason,
          price: sellPrice,
          qty
        });
      } else {
        this.log.error('Agartha: Falló la colocación de la orden de salida:', sellResult.error);
      }
    } catch (error) {
      this.log.error('Agartha: Excepción durante la orden de salida:', error);
    }
  }

  private async evaluateExitTimeouts(currentPrice: number) {
    if (!this.state.sellSequence || !this.state.sellOrderTimestamp) return;

    const elapsed = Date.now() - this.state.sellOrderTimestamp;

    // 1. A los 60 segundos (1 min): Re-quote al bid actual
    if (elapsed >= 60000 && !this.state.hasReordered60s) {
      this.log.warn(`[AGARTHA] Re-quote (60s): La orden de venta no se ha llenado. Re-cotizando al precio bid actual ($${currentPrice.toFixed(4)} USD)...`);
      await this.orderManager.cancelOrder(this.wallet, this.state.sellSequence);
      
      this.state.sellSequence = undefined;
      this.saveState();

      // Colocar nueva orden al bid actual
      await this.startExit(currentPrice, 'REQUOTE_60S_BID');
      this.state.hasReordered60s = true;
      this.saveState();
      return;
    }

    // 2. A los 5 minutos (300s): Re-quote al borde del trail floor
    if (elapsed >= 300000 && !this.state.hasReordered5m) {
      const trailBorder = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
      this.log.warn(`[AGARTHA] Re-quote (5m): La orden sigue colgada. Colocando al borde inferior del piso de trail ($${trailBorder.toFixed(4)} USD)...`);
      await this.orderManager.cancelOrder(this.wallet, this.state.sellSequence);
      
      this.state.sellSequence = undefined;
      this.saveState();

      // Colocar al borde de salida
      await this.startExit(trailBorder, 'REQUOTE_5M_BORDER');
      this.state.hasReordered5m = true;
      this.saveState();
      return;
    }

    // 3. A los 10 minutos (600s): Marcar como STALE_EXIT y alertar
    if (elapsed >= 600000 && this.state.status !== 'STALE_EXIT') {
      this.log.error(`[AGARTHA] ALERTA CRÍTICA (10m): La orden de venta del token volátil no se llenó. Se marca como STALE_EXIT para intervención manual del supervisor.`);
      this.state.status = 'STALE_EXIT';
      this.saveState();
    }
  }

  private async fetchAssetPrice(): Promise<number> {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${config.agarthaCexOracle}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = (await res.json()) as { symbol: string; price: string };
      return parseFloat(data.price);
    } catch (error) {
      this.log.warn(`Agartha: Error obteniendo precio de ${config.agarthaCexOracle}:`, (error as any).message);
      return 0;
    }
  }

  private resetState() {
    this.state = {
      epochId: '',
      positionSize: 0,
      entryPrice: 0,
      peakPrice: 0,
      isTrailingActive: false,
      ledgersInPosition: 0,
      sellSequence: undefined,
      sellLimitPrice: undefined,
      sellOrderTimestamp: undefined,
      hasReordered60s: false,
      hasReordered5m: false,
      status: 'ACTIVE'
    };
  }

  private saveState() {
    db.saveCustomData('agartha_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('agartha_state');
    if (saved && saved.epochId !== undefined) {
      this.state = saved as AgarthaState;
      this.log.info(`Agartha: Estado restaurado (Posición: ${this.state.positionSize} ${config.agarthaAssetCode}, Trailing: ${this.state.isTrailingActive}).`);
    }
  }

  private async updateAgarthaDashboard(marketPrice: number) {
    const trailingFloor = this.state.peakPrice * (1 - config.agarthaTrailingStopPct / 100);
    await this.updateDashboardWithBalances({
      midPrice: marketPrice.toString(),
      buyTarget: this.state.buySequence ? `Limit: ${this.state.buyLimitPrice}` : 'None',
      sellTarget: this.state.sellSequence ? `Venta: ${this.state.sellLimitPrice}` : (this.state.isTrailingActive ? trailingFloor.toFixed(4) : 'Trailing Inactivo'),
      activeBuySeq: this.state.buySequence ? `Buy Seq: ${this.state.buySequence}` : 'Ninguna',
      activeSellSeq: this.state.sellSequence ? `Exit Seq: ${this.state.sellSequence}` : (this.state.positionSize > 0 ? `Peak: ${this.state.peakPrice.toFixed(4)}` : 'Ninguna'),
      strategyName: 'Agartha Moonshot',
      activeRungs: this.state.positionSize > 0 ? '1 / 1' : '0 / 1',
      botStatus: this.state.sellSequence ? `Slippage Re-quote (Status: ${this.state.status})` : (this.state.positionSize > 0 ? `In Position (${this.state.isTrailingActive ? 'Trailing active' : 'Tracking activation'})` : 'Waiting for entry')
    });
  }
}
