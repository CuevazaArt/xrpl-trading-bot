import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface MashaPurchase {
  price: number;
  qty: number;
  timestamp: number;
  txHash: string;
}

interface MashaState {
  lastPurchasePrice: number;
  totalVolume: number;
  totalCost: number;
  purchases: MashaPurchase[];
}

export class XRPLMashaStrategy extends AbstractStrategy {
  public readonly name = 'masha';
  private state: MashaState = {
    lastPurchasePrice: 0,
    totalVolume: 0,
    totalCost: 0,
    purchases: []
  };

  protected async onInit(): Promise<void> {
    this.loadState();
    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Masha DCA Accumulator'
    });

    if (this.state.lastPurchasePrice > 0) {
      this.log.info(`[MASHA] Estado previo restaurado. Última compra de referencia cargada: $${this.state.lastPurchasePrice.toFixed(4)} USD.`);
      this.log.info(`[MASHA] Bolsa acumulada hasta la fecha: ${this.state.totalVolume.toFixed(2)} XRP (Costo Promedio: $${(this.state.totalCost / this.state.totalVolume || 0).toFixed(4)} USD).`);
    } else {
      this.log.info('[MASHA] Iniciando acumulador limpio. Sin compras registradas.');
    }

    this.log.info(`Masha inicializada: buy_qty=${config.mashaBuyQtyXrp} XRP, dca_step=${config.mashaDcaStepPct}%`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    const isInitialBuy = this.state.purchases.length === 0;

    if (isInitialBuy) {
      this.log.info('[MASHA] Sin compras registradas. Ejecutando compra inicial a mercado...');
      await this.executeBuy(marketPrice);
      return;
    }

    // Calcular el precio gatillo para la siguiente compra DCA
    const dcaTriggerPrice = this.state.lastPurchasePrice * (1 - config.mashaDcaStepPct / 100);
    const shouldAccumulate = marketPrice <= dcaTriggerPrice;

    const avgPrice = this.state.totalCost / this.state.totalVolume || 0;
    this.log.info(`Masha Status: Bolsa=${this.state.totalVolume.toFixed(2)} XRP | Promedio=$${avgPrice.toFixed(4)} | Última Compra=$${this.state.lastPurchasePrice.toFixed(4)} | Siguiente DCA<=$${dcaTriggerPrice.toFixed(4)} USD`);

    await this.updateMashaDashboard(marketPrice, avgPrice, dcaTriggerPrice);

    if (shouldAccumulate) {
      this.log.info(`[MASHA] Gatillo DCA activado: precio mercado (${marketPrice.toFixed(4)}) <= gatillo (${dcaTriggerPrice.toFixed(4)})`);
      await this.executeBuy(marketPrice);
    }
  }

  async cleanup(): Promise<void> {
    this.log.info('Cleanup: Masha es una acumuladora HODL pura. No hay órdenes límite que limpiar.');
  }

  private async executeBuy(price: number) {
    const buyQty = config.mashaBuyQtyXrp;
    const maxBuyPrice = price * 1.01;
    const usdCost = (buyQty * maxBuyPrice).toFixed(4);
    const takerPays = (buyQty * 1000000).toString();
    const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

    this.log.info(`Masha: Ejecutando compra Spot de ${buyQty} XRP (Límite: ${maxBuyPrice.toFixed(4)} USD)`);

    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!buyResult.success || !buyResult.sequence) {
        this.log.error('Masha: Compra Spot falló:', buyResult.error);
        return;
      }

      this.log.info(`Masha: Compra exitosa. Hash: ${buyResult.hash}`);
      db.logTransaction('MASHA_BUY', buyResult.hash || '', 'tesSUCCESS', { price, amount: buyQty });

      this.state.purchases.push({
        price,
        qty: buyQty,
        timestamp: Date.now(),
        txHash: buyResult.hash || ''
      });

      this.state.lastPurchasePrice = price;
      this.state.totalVolume += buyQty;
      this.state.totalCost += buyQty * price;

      this.saveState();
    } catch (error) {
      this.log.error('Masha: Excepción crítica durante la compra:', error);
    }
  }

  private saveState() {
    db.saveCustomData('masha_state', this.state);
  }

  private loadState() {
    const saved = db.getCustomData('masha_state');
    if (saved && Array.isArray(saved.purchases)) {
      this.state = saved as MashaState;
    }
  }

  private async updateMashaDashboard(marketPrice: number, avgPrice: number, dcaTriggerPrice: number) {
    await this.updateDashboardWithBalances({
      midPrice: marketPrice.toString(),
      buyTarget: dcaTriggerPrice.toString(),
      sellTarget: 'None (HODL Bag)',
      activeBuySeq: `Total XRP: ${this.state.totalVolume.toFixed(2)}`,
      activeSellSeq: 'Ninguna (Earn Hold)',
      strategyName: 'Masha DCA Accumulator',
      activeRungs: `Compras: ${this.state.purchases.length}`,
      botStatus: `Acumulando (Promedio: $${avgPrice.toFixed(4)})`
    });
  }
}
