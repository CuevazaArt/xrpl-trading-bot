import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface DorothyRung {
  buySequence?: number;
  buyPrice: number;
  buyQty: number;
  sellSequence?: number;
  sellPrice: number;
  status: 'BUYING' | 'ACTIVE' | 'CLOSED' | 'ORPHANED';
  timestamp: number;
}

export class XRPLDorothyStrategy extends AbstractStrategy {
  public readonly name = 'dorothy';

  // Estado persistente en memoria para los rungs
  private rungs: DorothyRung[] = [];

  protected async onInit(): Promise<void> {
    this.loadStateFromDB();
    this.dashboard.updateState({
      walletAddress: this.wallet.address,
      strategyName: 'Dorothy DCA Long'
    });
    this.log.info(`Dorothy inicializada con profit_factor=${config.dorothyProfitFactor}, margin_drop_factor=${config.dorothyMarginDropFactor}, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. Verificar fills y actualizar estado de rungs en base a las ofertas activas en el Ledger
    await this.syncRungsWithLedger();

    // 2. Determinar tendencia y compuertas de entrada usando datos de velas
    const { trendOk, entryOk, candleOpen1h } = await this.checkTrendGates(marketPrice);
    
    const activeRungs = this.rungs.filter(r => r.status === 'ACTIVE').length;
    this.log.info(`Dorothy Estado: Rungs Activos = ${activeRungs}/${config.maxRungs} | Precio Mercado = ${marketPrice.toFixed(4)} USD`);
    this.log.info(`Dorothy Compuertas: Tendencia (Alcista) = ${trendOk ? 'OPEN' : 'BLOCKED'} | Entrada (Bajo Apertura 1h: ${candleOpen1h.toFixed(4)}) = ${entryOk ? 'OPEN' : 'BLOCKED'}`);

    const statusText = `Tendencia: ${trendOk ? 'ALCISTA' : 'BAJISTA'} | Entrada: ${entryOk ? 'OK' : 'BLOCKED'}`;
    await this.updateDorothyDashboard(marketPrice, activeRungs, statusText);

    if (!trendOk || !entryOk) {
      this.log.info('Ciclo de compra omitido por compuertas de tendencia/entrada.');
      return;
    }

    // 3. Evaluar lógica de compras DCA
    let shouldBuy = false;

    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    if (activeRungList.length === 0) {
      shouldBuy = true;
      this.log.info('Sin rungs activos. Iniciando primer peldaño de Dorothy...');
    } else {
      const lowestRung = activeRungList.reduce((prev, curr) => (prev.buyPrice < curr.buyPrice) ? prev : curr);
      const triggerThreshold = lowestRung.buyPrice * (1 - config.dorothyMarginDropFactor);
      shouldBuy = marketPrice <= triggerThreshold;
      this.log.info(`Evaluando DCA: Precio más bajo = ${lowestRung.buyPrice.toFixed(4)} | Umbral = ${triggerThreshold.toFixed(4)} USD | Compra = ${shouldBuy}`);
    }

    if (shouldBuy && activeRungs >= config.maxRungs) {
      this.log.warn(`Techo de rungs alcanzado (${activeRungs}/${config.maxRungs}). Compra bloqueada.`);
      return;
    }

    if (shouldBuy) {
      await this.executeBuyAndPlaceTP(marketPrice);
    }
  }

  async cleanup(): Promise<void> {
    this.log.info('Cleanup: Dorothy mantendrá las órdenes límites de venta en el DEX.');
  }

  private async syncRungsWithLedger() {
    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address,
      });

      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      let changed = false;
      for (const rung of this.rungs) {
        if (rung.status === 'ACTIVE' && rung.sellSequence !== undefined) {
          if (!activeSequences.has(rung.sellSequence)) {
            this.log.info(`¡Dorothy Rung llenado! Venta TP completada (Seq: ${rung.sellSequence}, Precio: ${rung.sellPrice} USD)`);
            rung.status = 'CLOSED';
            db.logTransaction('DOROTHY_TP_FILLED', '', 'FILLED', {
              buyPrice: rung.buyPrice, sellPrice: rung.sellPrice, qty: rung.buyQty
            });
            changed = true;
          }
        }
      }

      if (changed) {
        this.rungs = this.rungs.filter(r => r.status !== 'CLOSED');
        this.saveStateToDB();
      }
    } catch (error) {
      this.log.error('Error al sincronizar rungs con Ledger:', error);
    }
  }

  private async checkTrendGates(marketPrice: number): Promise<{ trendOk: boolean; entryOk: boolean; candleOpen1h: number }> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=10');
      if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
      const klines = (await res.json()) as any[];

      if (!klines || klines.length < 2) {
        return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };
      }

      let prevHAOpen = parseFloat(klines[0][1]);
      let prevHAClose = parseFloat(klines[0][4]);

      const haCandles = klines.map((k) => {
        const o = parseFloat(k[1]);
        const h = parseFloat(k[2]);
        const l = parseFloat(k[3]);
        const c = parseFloat(k[4]);
        const haClose = (o + h + l + c) / 4;
        const haOpen = (prevHAOpen + prevHAClose) / 2;
        prevHAOpen = haOpen;
        prevHAClose = haClose;
        return { haOpen, haClose };
      });

      const lastHA = haCandles[haCandles.length - 1];
      const trendOk = lastHA.haClose > lastHA.haOpen;
      const lastRegularOpen = parseFloat(klines[klines.length - 1][1]);
      const entryOk = marketPrice < lastRegularOpen;

      return { trendOk, entryOk, candleOpen1h: lastRegularOpen };
    } catch (error) {
      this.log.warn('Error al verificar compuertas de tendencia:', (error as any).message);
      return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };
    }
  }

  private async executeBuyAndPlaceTP(marketPrice: number) {
    const buyQtyXrp = parseFloat(config.rungQtyXrp);
    const maxBuyPrice = marketPrice * 1.01;
    const usdCost = (buyQtyXrp * maxBuyPrice).toFixed(4);

    const takerPays = (buyQtyXrp * 1000000).toString();
    const takerGets = { currency: 'USD', value: usdCost, issuer: this.usdIssuer };

    this.log.info(`Dorothy DCA: Comprando ${buyQtyXrp} XRP a mercado (Límite: ${maxBuyPrice.toFixed(4)} USD)`);

    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!buyResult.success || !buyResult.sequence) {
        this.log.error('Dorothy: Falló orden de compra inicial.', buyResult.error);
        db.logTransaction('DOROTHY_COMPRA_FALLIDA', '', buyResult.error || 'ERROR', { qty: buyQtyXrp });
        return;
      }

      db.logTransaction('DOROTHY_COMPRA', buyResult.hash || '', 'tesSUCCESS', { price: marketPrice, amount: buyQtyXrp });

      const sellPrice = parseFloat((marketPrice * (1 + config.dorothyProfitFactor)).toFixed(4));
      const sellUsdValue = (buyQtyXrp * sellPrice).toFixed(4);

      const sellTakerPays = { currency: 'USD', value: sellUsdValue, issuer: this.usdIssuer };
      const sellTakerGets = (buyQtyXrp * 1000000).toString();

      this.log.info(`Dorothy TP: Colocando venta límite de ${buyQtyXrp} XRP a ${sellPrice.toFixed(4)} USD`);
      const sellResult = await this.orderManager.createLimitOrder(this.wallet, sellTakerPays, sellTakerGets);

      if (sellResult.success && sellResult.sequence !== undefined) {
        this.rungs.push({
          buyPrice: marketPrice, buyQty: buyQtyXrp, buySequence: buyResult.sequence,
          sellSequence: sellResult.sequence, sellPrice, status: 'ACTIVE', timestamp: Date.now()
        });
        this.saveStateToDB();
        db.logTransaction('DOROTHY_TP_LIMIT', sellResult.hash || '', 'tesSUCCESS', { price: sellPrice, amount: buyQtyXrp });
      } else {
        this.log.error(`¡DOROTHY POSICIÓN HUÉRFANA! Compra exitosa pero Venta falló: ${sellResult.error}`);
        this.rungs.push({
          buyPrice: marketPrice, buyQty: buyQtyXrp, buySequence: buyResult.sequence,
          sellPrice, status: 'ORPHANED', timestamp: Date.now()
        });
        this.saveStateToDB();
        db.logTransaction('DOROTHY_TP_FALLIDA_HUERFANA', '', sellResult.error || 'ERROR_TP', { buyPrice: marketPrice });
      }
    } catch (error) {
      this.log.error('Excepción crítica en executeBuyAndPlaceTP de Dorothy:', error);
    }
  }

  private saveStateToDB() {
    try { db.saveCustomData('dorothy_rungs', this.rungs); } catch (error) { this.log.error('Error al guardar estado:', error); }
  }

  private loadStateFromDB() {
    try {
      const saved = db.getCustomData('dorothy_rungs');
      if (Array.isArray(saved)) { this.rungs = saved; this.log.info(`Dorothy: Recuperados ${this.rungs.length} rungs de la DB.`); }
    } catch (error) { this.log.error('Error al cargar estado:', error); }
  }

  private async updateDorothyDashboard(marketPrice: number, activeRungs: number, statusText: string) {
    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    let buyTarget = marketPrice;
    let sellTarget = marketPrice * (1 + config.dorothyProfitFactor);

    if (activeRungList.length > 0) {
      const lowestRung = activeRungList.reduce((prev, curr) => (prev.buyPrice < curr.buyPrice) ? prev : curr);
      buyTarget = lowestRung.buyPrice * (1 - config.dorothyMarginDropFactor);
      sellTarget = lowestRung.sellPrice;
    }

    await this.updateDashboardWithBalances({
      midPrice: marketPrice.toString(),
      buyTarget: buyTarget.toString(),
      sellTarget: sellTarget.toString(),
      activeBuySeq: activeRungList.length > 0 ? `Lowest Buy: ${activeRungList[0].buyPrice.toFixed(4)}` : 'Ninguna',
      activeSellSeq: activeRungList.length > 0 ? `Sells Active: ${activeRungList.map(r => r.sellSequence).join(', ')}` : 'Ninguna',
      strategyName: 'Dorothy DCA Long',
      activeRungs: `${activeRungs} / ${config.maxRungs}`,
      botStatus: statusText
    });
  }
}
