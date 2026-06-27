import { db } from '../db.js';
import { config } from '../config.js';
import { AbstractStrategy } from './AbstractStrategy.js';

interface ElphabaRung {
  sellSequence?: number;
  sellPrice: number;
  sellQty: number;
  buySequence?: number;
  buyPrice: number;
  status: 'SELLING' | 'ACTIVE' | 'CLOSED' | 'ORPHANED';
  timestamp: number;
}

export class XRPLElphabaStrategy extends AbstractStrategy {
  public readonly name = 'elphaba';
  private rungs: ElphabaRung[] = [];

  protected async onInit(): Promise<void> {
    // Intentar recuperar rungs previos desde la DB local si existen
    this.loadStateFromDB();
    this.dashboard.updateState({ walletAddress: this.wallet.address, strategyName: 'Elphaba DCA Short' });
    this.log.info(`Elphaba inicializada con profit_factor=${config.elphabaProfitFactor}, margin_rise_factor=${config.elphabaMarginRiseFactor}, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    await this.syncRungsWithLedger();
    const { trendOk, entryOk, candleOpen1h } = await this.checkTrendGates(marketPrice);
    
    const activeRungs = this.rungs.filter(r => r.status === 'ACTIVE').length;
    this.log.info(`Elphaba Estado: Rungs Activos = ${activeRungs}/${config.maxRungs} | Precio Mercado = ${marketPrice.toFixed(4)} USD`);
    this.log.info(`Elphaba Compuertas: Tendencia (Bajista) = ${trendOk ? 'OPEN' : 'BLOCKED'} | Entrada (Sobre Apertura 1h: ${candleOpen1h.toFixed(4)}) = ${entryOk ? 'OPEN' : 'BLOCKED'}`);

    const statusText = `Tendencia: ${trendOk ? 'BAJISTA' : 'ALCISTA'} | Entrada: ${entryOk ? 'OK' : 'BLOCKED'}`;
    await this.updateElphabaDashboard(marketPrice, activeRungs, statusText);

    if (!trendOk || !entryOk) { this.log.info('Ciclo de venta en corto omitido.'); return; }

    let shouldSell = false;
    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    if (activeRungList.length === 0) {
      shouldSell = true;
      this.log.info('Sin rungs activos. Iniciando primer peldaño en corto...');
    } else {
      const highestRung = activeRungList.reduce((prev, curr) => (prev.sellPrice > curr.sellPrice) ? prev : curr);
      const triggerThreshold = highestRung.sellPrice * (1 + config.elphabaMarginRiseFactor);
      shouldSell = marketPrice >= triggerThreshold;
      this.log.info(`Evaluando DCA Short: Precio más alto = ${highestRung.sellPrice.toFixed(4)} | Umbral = ${triggerThreshold.toFixed(4)} USD | Venta = ${shouldSell}`);
    }

    if (shouldSell && activeRungs >= config.maxRungs) { this.log.warn(`Techo de rungs alcanzado.`); return; }
    if (shouldSell) { await this.executeSellAndPlaceTP(marketPrice); }
  }

  async cleanup(): Promise<void> {
    this.log.info('Cleanup: Elphaba mantendrá las órdenes límites de recompra en el DEX.');
  }

  private async syncRungsWithLedger() {
    try {
      const response = await this.client.request({ command: 'account_offers', account: this.wallet.address });
      const activeSequences = new Set(response.result.offers?.map((offer: any) => offer.seq) || []);
      let changed = false;

      for (const rung of this.rungs) {
        if (rung.status === 'ACTIVE' && rung.buySequence !== undefined && !activeSequences.has(rung.buySequence)) {
          this.log.info(`¡Elphaba Rung llenado! Recompra TP completada (Seq: ${rung.buySequence}, Precio: ${rung.buyPrice} USD)`);
          rung.status = 'CLOSED';
          db.logTransaction('ELPHABA_TP_FILLED', '', 'FILLED', { sellPrice: rung.sellPrice, buyPrice: rung.buyPrice, qty: rung.sellQty });
          changed = true;
        }
      }
      if (changed) { this.rungs = this.rungs.filter(r => r.status !== 'CLOSED'); this.saveStateToDB(); }
    } catch (error) { this.log.error('Error al sincronizar rungs:', error); }
  }

  private async checkTrendGates(marketPrice: number): Promise<{ trendOk: boolean; entryOk: boolean; candleOpen1h: number }> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=10');
      if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
      const klines = (await res.json()) as any[];
      if (!klines || klines.length < 2) return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };


      let prevHAOpen = parseFloat(klines[0][1]);
      let prevHAClose = parseFloat(klines[0][4]);
      const haCandles = klines.map((k) => {
        const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]);
        const haClose = (o + h + l + c) / 4;
        const haOpen = (prevHAOpen + prevHAClose) / 2;
        prevHAOpen = haOpen; prevHAClose = haClose;
        return { haOpen, haClose };
      });
      const lastHA = haCandles[haCandles.length - 1];
      const trendOk = lastHA.haClose < lastHA.haOpen; // Bearish
      const lastRegularOpen = parseFloat(klines[klines.length - 1][1]);
      const entryOk = marketPrice > lastRegularOpen;
      return { trendOk, entryOk, candleOpen1h: lastRegularOpen };
    } catch (error) {
      this.log.warn('Error al verificar compuertas en Elphaba:', (error as any).message);
      return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };
    }
  }

  private async executeSellAndPlaceTP(marketPrice: number) {
    const sellQtyXrp = parseFloat(config.rungQtyXrp);
    const minSellPrice = marketPrice * 0.99;
    const usdReturn = (sellQtyXrp * minSellPrice).toFixed(4);

    const takerPays = { currency: 'USD', value: usdReturn, issuer: this.usdIssuer };
    const takerGets = (sellQtyXrp * 1000000).toString();

    this.log.info(`Elphaba Short Entry: Vendiendo ${sellQtyXrp} XRP a mercado`);

    try {
      const xrpBalanceRaw = await this.client.getXrpBalance(this.wallet.address);
      const xrpBalance = typeof xrpBalanceRaw === 'string' ? parseFloat(xrpBalanceRaw) : xrpBalanceRaw;
      if (xrpBalance < sellQtyXrp + 15) { this.log.warn(`Balance insuficiente (${xrpBalance.toFixed(2)} XRP).`); return; }

      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      if (!sellResult.success || !sellResult.sequence) { this.log.error('Falló orden de venta:', sellResult.error); return; }

      db.logTransaction('ELPHABA_VENTA_SHORT', sellResult.hash || '', 'tesSUCCESS', { price: marketPrice, amount: sellQtyXrp });

      const buyPrice = parseFloat((marketPrice * (1 - config.elphabaProfitFactor)).toFixed(4));
      const buyUsdCost = (sellQtyXrp * buyPrice).toFixed(4);
      const buyTakerPays = (sellQtyXrp * 1000000).toString();
      const buyTakerGets = { currency: 'USD', value: buyUsdCost, issuer: this.usdIssuer };

      this.log.info(`Elphaba TP Recompra: ${sellQtyXrp} XRP a ${buyPrice.toFixed(4)} USD`);
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, buyTakerPays, buyTakerGets);

      if (buyResult.success && buyResult.sequence !== undefined) {
        this.rungs.push({ sellPrice: marketPrice, sellQty: sellQtyXrp, sellSequence: sellResult.sequence, buySequence: buyResult.sequence, buyPrice, status: 'ACTIVE', timestamp: Date.now() });
        this.saveStateToDB();
        db.logTransaction('ELPHABA_TP_BUY_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: buyPrice, amount: sellQtyXrp });
      } else {
        this.log.error(`¡ELPHABA POSICIÓN HUÉRFANA! Venta exitosa pero Compra falló: ${buyResult.error}`);
        this.rungs.push({ sellPrice: marketPrice, sellQty: sellQtyXrp, sellSequence: sellResult.sequence, buyPrice, status: 'ORPHANED', timestamp: Date.now() });
        this.saveStateToDB();
      }
    } catch (error) { this.log.error('Excepción crítica en executeSellAndPlaceTP:', error); }
  }

  private saveStateToDB() { try { db.saveCustomData('elphaba_rungs', this.rungs); } catch (error) { this.log.error('Error al guardar estado:', error); } }
  private loadStateFromDB() { try { const saved = db.getCustomData('elphaba_rungs'); if (Array.isArray(saved)) { this.rungs = saved; this.log.info(`Elphaba: Recuperados ${this.rungs.length} rungs.`); } } catch (error) { this.log.error('Error al cargar estado:', error); } }

  private async updateElphabaDashboard(marketPrice: number, activeRungs: number, statusText: string) {
    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    let buyTarget = marketPrice * (1 - config.elphabaProfitFactor);
    let sellTarget = marketPrice;
    if (activeRungList.length > 0) {
      const highestRung = activeRungList.reduce((prev, curr) => (prev.sellPrice > curr.sellPrice) ? prev : curr);
      buyTarget = highestRung.buyPrice;
      sellTarget = highestRung.sellPrice * (1 + config.elphabaMarginRiseFactor);
    }
    await this.updateDashboardWithBalances({
      midPrice: marketPrice.toString(), buyTarget: buyTarget.toString(), sellTarget: sellTarget.toString(),
      activeBuySeq: activeRungList.length > 0 ? `Buys Active: ${activeRungList.map(r => r.buySequence).join(', ')}` : 'Ninguna',
      activeSellSeq: activeRungList.length > 0 ? `Highest Sell: ${activeRungList[0].sellPrice.toFixed(4)}` : 'Ninguna',
      strategyName: 'Elphaba DCA Short', activeRungs: `${activeRungs} / ${config.maxRungs}`, botStatus: statusText
    });
  }
}
