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
}

export class XRPLAgarthaStrategy extends AbstractStrategy {
  public readonly name = 'agartha';
  private state: AgarthaState = {
    epochId: '',
    positionSize: 0,
    entryPrice: 0,
    peakPrice: 0,
    isTrailingActive: false,
    ledgersInPosition: 0
  };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Agartha Moonshot Trailing'
    });
    this.log.info(`Agartha initialized: asset=${config.agarthaAssetCode}, budget=$${config.agarthaBudgetUsd} USD, trailing_stop=${config.agarthaTrailingStopPct}%, activation_profit=${config.agarthaActivationProfitPct}%`);
  }

  async tick(currentLedger: number, marketPriceXrp: number): Promise<void> {
    // 1. Obtener precio del activo volátil desde el oráculo CEX de alta velocidad (Binance)
    const assetPrice = await this.fetchAssetPrice();
    if (assetPrice <= 0) {
      this.log.warn(`Agartha: No se pudo obtener cotización para ${config.agarthaAssetCode}. Omitiendo tick.`);
      return;
    }

    await this.syncBuyLimitOrder(assetPrice);

    // Si no hay posición activa ni orden pendiente, ejecutar compra inicial
    if (this.state.positionSize === 0 && !this.state.buySequence) {
      this.log.info(`Agartha: Buscando entrada en ${config.agarthaAssetCode} a precio $${assetPrice.toFixed(4)} USD...`);
      await this.placeEntry(assetPrice);
      return;
    }

    // Gestionar posición abierta
    if (this.state.positionSize > 0) {
      this.state.ledgersInPosition++;

      // Time Stop de seguridad
      if (this.state.ledgersInPosition >= config.agarthaMaxHoldingLedgers) {
        this.log.warn(`Agartha Time Stop: Posición retenida durante ${this.state.ledgersInPosition} ledgers. Liquidando...`);
        await this.liquidatePosition(assetPrice, 'TIME_STOP');
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
          this.log.warn(`¡Agartha Trailing Stop gatillado! Liquidando moonshot en ${config.agarthaAssetCode}...`);
          await this.liquidatePosition(assetPrice, 'TRAILING_EXIT');
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
        const buyQty = config.agarthaBudgetUsd / fillPrice;
        
        this.log.info(`Agartha: Entry-Limit llenado! (Seq: ${this.state.buySequence}, Precio: ${fillPrice})`);
        
        this.state.positionSize = buyQty;
        this.state.entryPrice = fillPrice;
        this.state.peakPrice = fillPrice;
        this.state.isTrailingActive = false;
        this.state.buySequence = undefined;
        this.state.buyLimitPrice = undefined;
        this.state.ledgersInPosition = 0;
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

  private async placeEntry(marketPrice: number) {
    const buyQty = config.agarthaBudgetUsd / marketPrice;

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

  private async liquidatePosition(currentPrice: number, reason: string) {
    const qty = this.state.positionSize;
    const minSellPrice = currentPrice * 0.99;
    const usdCost = (qty * minSellPrice).toFixed(4);
    const takerPays = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };
    const takerGets = { currency: config.agarthaAssetCode, value: qty.toFixed(4), issuer: config.agarthaAssetIssuer };

    this.log.warn(`Agartha: Liquidando posición de ${qty.toFixed(4)} ${config.agarthaAssetCode} a $${currentPrice.toFixed(4)} USD (${reason})`);
    try {
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays as any, takerGets as any);
      if (sellResult.success) {
        db.logTransaction('AGARTHA_LIQUIDATED', sellResult.hash || '', 'tesSUCCESS', {
          asset: config.agarthaAssetCode,
          reason,
          entryPrice: this.state.entryPrice,
          exitPrice: currentPrice,
          qty,
          profitUsd: qty * (currentPrice - this.state.entryPrice)
        });
        
        this.state = {
          epochId: '',
          positionSize: 0,
          entryPrice: 0,
          peakPrice: 0,
          isTrailingActive: false,
          ledgersInPosition: 0
        };
        this.saveState();
      } else {
        this.log.error('Agartha: Falló la liquidación de la posición:', sellResult.error);
      }
    } catch (error) {
      this.log.error('Agartha: Excepción durante la liquidación:', error);
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
      sellTarget: this.state.isTrailingActive ? trailingFloor.toFixed(4) : 'Trailing Inactivo',
      activeBuySeq: this.state.buySequence ? `Buy Seq: ${this.state.buySequence}` : 'Ninguna',
      activeSellSeq: this.state.positionSize > 0 ? `Peak: ${this.state.peakPrice.toFixed(4)}` : 'Ninguna',
      strategyName: 'Agartha Moonshot',
      activeRungs: this.state.positionSize > 0 ? '1 / 1' : '0 / 1',
      botStatus: this.state.positionSize > 0 ? `In Position (${this.state.isTrailingActive ? 'Trailing active' : 'Tracking activation'})` : 'Waiting for entry'
    });
  }
}
