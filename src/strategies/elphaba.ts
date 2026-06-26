import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('ElphabaStrategy');

interface ElphabaRung {
  sellSequence?: number;
  sellPrice: number;
  sellQty: number;
  buySequence?: number;
  buyPrice: number;
  status: 'SELLING' | 'ACTIVE' | 'CLOSED' | 'ORPHANED';
  timestamp: number;
}

export class XRPLElphabaStrategy implements IStrategy {
  public readonly name = 'elphaba';

  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  // Estado persistente en memoria para los rungs
  private rungs: ElphabaRung[] = [];

  // Emisor de USD
  private usdIssuer = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

  async init(
    client: Client,
    wallet: Wallet,
    orderManager: XRPLOrderManager,
    dashboard: XRPLDashboard
  ): Promise<void> {
    this.client = client;
    this.wallet = wallet;
    this.orderManager = orderManager;
    this.dashboard = dashboard;

    // Intentar recuperar rungs previos desde la DB local si existen
    this.loadStateFromDB();

    this.dashboard.updateState({
      walletAddress: wallet.address,
      strategyName: 'Elphaba DCA Short'
    });

    log.info(`Elphaba inicializada con profit_factor=${config.elphabaProfitFactor}, margin_rise_factor=${config.elphabaMarginRiseFactor}, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. Verificar fills y actualizar estado de rungs en base a las ofertas activas en el Ledger
    await this.syncRungsWithLedger();

    // 2. Determinar tendencia y compuertas de entrada usando datos de velas (Binance API pública)
    const { trendOk, entryOk, candleOpen1h } = await this.checkTrendGates(marketPrice);
    
    const activeRungs = this.rungs.filter(r => r.status === 'ACTIVE').length;
    log.info(`Elphaba Estado: Rungs Activos = ${activeRungs}/${config.maxRungs} | Precio Mercado = ${marketPrice.toFixed(4)} USD`);
    log.info(`Elphaba Compuertas: Tendencia (Bajista) = ${trendOk ? 'OPEN' : 'BLOCKED'} | Entrada (Sobre Apertura 1h: ${candleOpen1h.toFixed(4)}) = ${entryOk ? 'OPEN' : 'BLOCKED'}`);

    this.updateDashboard(marketPrice, activeRungs, `Tendencia: ${trendOk ? 'BAJISTA' : 'ALCISTA'} | Entrada: ${entryOk ? 'OK' : 'BLOCKED'}`);

    // Si las compuertas de tendencia o entrada están bloqueadas, no realizamos nuevas ventas
    if (!trendOk || !entryOk) {
      log.info('Ciclo de venta en corto omitido por compuertas de tendencia/entrada.');
      return;
    }

    // 3. Evaluar lógica de ventas DCA en corto
    let shouldSell = false;
    let highestSellPrice = 0;

    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    if (activeRungList.length === 0) {
      // Sin peldaños activos, podemos hacer la primera venta
      shouldSell = true;
      log.info('Sin rungs activos. Iniciando primer peldaño en corto de Elphaba...');
    } else {
      // Encontrar el precio de venta del peldaño más alto
      const highestRung = activeRungList.reduce((prev, curr) => (prev.sellPrice > curr.sellPrice) ? prev : curr);
      highestSellPrice = highestRung.sellPrice;

      // Elphaba vende más arriba si el precio sube el porcentaje marginRiseFactor
      const triggerThreshold = highestSellPrice * (1 + config.elphabaMarginRiseFactor);
      shouldSell = marketPrice >= triggerThreshold;
      
      log.info(`Evaluando DCA Short: Precio más alto = ${highestSellPrice.toFixed(4)} | Umbral disparo comp. = ${triggerThreshold.toFixed(4)} USD | Venta Short = ${shouldSell}`);
    }

    // Comprobar techo de rungs
    if (shouldSell && activeRungs >= config.maxRungs) {
      log.warn(`Techo de rungs en corto alcanzado (${activeRungs}/${config.maxRungs}). Venta bloqueada.`);
      return;
    }

    if (shouldSell) {
      await this.executeSellAndPlaceTP(marketPrice);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Elphaba mantendrá las órdenes límites de recompra en el DEX para no perder rentabilidad.');
  }

  // =====================================================================
  // SINCRONIZACIÓN DE RUNGS Y FILLS
  // =====================================================================

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
        if (rung.status === 'ACTIVE' && rung.buySequence !== undefined) {
          // Si el buySequence de nuestra compra Take Profit ya no está en las ofertas del Ledger, se ha llenado (FILLED)
          if (!activeSequences.has(rung.buySequence)) {
            log.info(`¡Elphaba Rung llenado! Recompra de Take Profit completada (Seq: ${rung.buySequence}, Precio: ${rung.buyPrice} USD)`);
            rung.status = 'CLOSED';
            db.logTransaction('ELPHABA_TP_FILLED', '', 'FILLED', {
              sellPrice: rung.sellPrice,
              buyPrice: rung.buyPrice,
              qty: rung.sellQty
            });
            changed = true;
          }
        }
      }

      // Filtrar y limpiar rungs cerrados
      if (changed) {
        this.rungs = this.rungs.filter(r => r.status !== 'CLOSED');
        this.saveStateToDB();
      }
    } catch (error) {
      log.error('Error al sincronizar rungs en Elphaba con Ledger (account_offers):', error);
    }
  }

  // =====================================================================
  // COMPUERTAS DE TENDENCIA (BINANCE API VELAS)
  // =====================================================================

  private async checkTrendGates(marketPrice: number): Promise<{ trendOk: boolean; entryOk: boolean; candleOpen1h: number }> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=10');
      if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
      const klines: any[] = await res.json();

      if (!klines || klines.length < 2) {
        return { trendOk: true, entryOk: true, candleOpen1h: marketPrice }; // Safe fallback
      }

      // Calcular Heikin Ashi para las velas
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
      
      // Elphaba requiere tendencia bajista (Bearish): HA Close < HA Open
      const trendOk = lastHA.haClose < lastHA.haOpen;

      // Compuerta de Entrada: Precio actual > Apertura de la última vela de 1h regular (vender la subida)
      const lastRegularOpen = parseFloat(klines[klines.length - 1][1]);
      const entryOk = marketPrice > lastRegularOpen;

      return {
        trendOk,
        entryOk,
        candleOpen1h: lastRegularOpen
      };
    } catch (error) {
      log.warn('Error al verificar compuertas en Elphaba (usando fallbacks permisivos):', (error as any).message);
      return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };
    }
  }

  // =====================================================================
  // EJECUCIÓN DE VENTA Y COLOCACIÓN DE COMPRA TAKE PROFIT (RECOMPRA)
  // =====================================================================

  private async executeSellAndPlaceTP(marketPrice: number) {
    const sellQtyXrp = parseFloat(config.rungQtyXrp);
    
    // Simular venta a mercado: ofertamos vender XRP recibiendo USD a un precio ligeramente menor (ej: -1%)
    // para asegurar llenado inmediato. XRPL lo emparejará al mejor precio de compra en el libro.
    const minSellPrice = marketPrice * 0.99;
    const usdReturn = (sellQtyXrp * minSellPrice).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdReturn,
      issuer: this.usdIssuer
    };
    const takerGets = (sellQtyXrp * 1000000).toString(); // XRP en drops

    log.info(`Elphaba Short Entry: Vendiendo ${sellQtyXrp} XRP a mercado (Límite: ${minSellPrice.toFixed(4)} USD)`);

    try {
      // Verificar si tenemos suficiente balance de XRP para vender en Spot
      const xrpBalanceRaw = await this.client.getXrpBalance(this.wallet.address);
      const xrpBalance = typeof xrpBalanceRaw === 'string' ? parseFloat(xrpBalanceRaw) : xrpBalanceRaw;
      if (xrpBalance < sellQtyXrp + 15) { // Mantener al menos 15 XRP de reserva
        log.warn(`Balance de XRP insuficiente para abrir corto (${xrpBalance.toFixed(2)} < ${sellQtyXrp + 15} XRP). Omitiendo ciclo.`);
        return;
      }

      const sellResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (!sellResult.success || !sellResult.sequence) {
        log.error('Elphaba: Falló orden de venta en corto inicial.', sellResult.error);
        db.logTransaction('ELPHABA_VENTA_FALLIDA', '', sellResult.error || 'ERROR', { qty: sellQtyXrp });
        return;
      }

      // Registro de venta
      db.logTransaction('ELPHABA_VENTA_SHORT', sellResult.hash || '', 'tesSUCCESS', { price: marketPrice, amount: sellQtyXrp });

      // Colocar Take Profit (Compra Límite de XRP con USD a un precio menor)
      const buyPrice = parseFloat((marketPrice * (1 - config.elphabaProfitFactor)).toFixed(4));
      const buyUsdCost = (sellQtyXrp * buyPrice).toFixed(4);

      const buyTakerPays = (sellQtyXrp * 1000000).toString(); // XRP en drops
      const buyTakerGets = {
        currency: 'USD',
        value: buyUsdCost,
        issuer: this.usdIssuer
      };

      log.info(`Elphaba TP Recompra: Colocando compra límite de ${sellQtyXrp} XRP a ${buyPrice.toFixed(4)} USD (Costo: ${buyUsdCost} USD)`);

      const buyResult = await this.orderManager.createLimitOrder(this.wallet, buyTakerPays, buyTakerGets);

      if (buyResult.success && buyResult.sequence !== undefined) {
        // Añadir Rung activo
        const newRung: ElphabaRung = {
          sellPrice: marketPrice,
          sellQty: sellQtyXrp,
          sellSequence: sellResult.sequence,
          buySequence: buyResult.sequence,
          buyPrice: buyPrice,
          status: 'ACTIVE',
          timestamp: Date.now()
        };
        this.rungs.push(newRung);
        this.saveStateToDB();

        db.logTransaction('ELPHABA_TP_BUY_LIMIT', buyResult.hash || '', 'tesSUCCESS', { price: buyPrice, amount: sellQtyXrp });
      } else {
        // Alerta crítica: venta exitosa pero compra falló (posición huérfana en USD)
        log.error(`¡ELPHABA POSICIÓN HUÉRFANA! Venta exitosa (Seq: ${sellResult.sequence}) pero Compra falló: ${buyResult.error}`);
        const newRung: ElphabaRung = {
          sellPrice: marketPrice,
          sellQty: sellQtyXrp,
          sellSequence: sellResult.sequence,
          buyPrice: buyPrice,
          status: 'ORPHANED',
          timestamp: Date.now()
        };
        this.rungs.push(newRung);
        this.saveStateToDB();
        db.logTransaction('ELPHABA_TP_FALLIDA_HUERFANA', '', buyResult.error || 'ERROR_TP', { sellPrice: marketPrice });
      }
    } catch (error) {
      log.error('Excepción crítica en executeSellAndPlaceTP de Elphaba:', error);
    }
  }

  // =====================================================================
  // PERSISTENCIA LOCAL DE ESTADO
  // =====================================================================

  private saveStateToDB() {
    try {
      db.saveCustomData('elphaba_rungs', this.rungs);
    } catch (error) {
      log.error('Error al guardar estado de Elphaba en DB:', error);
    }
  }

  private loadStateFromDB() {
    try {
      const saved = db.getCustomData('elphaba_rungs');
      if (Array.isArray(saved)) {
        this.rungs = saved;
        log.info(`Elphaba: Recuperados ${this.rungs.length} rungs previos de la DB.`);
      }
    } catch (error) {
      log.error('Error al cargar estado de Elphaba de DB:', error);
    }
  }

  // =====================================================================
  // DASHBOARD
  // =====================================================================

  private async updateDashboard(marketPrice: number, activeRungs: number, statusText: string) {
    try {
      const xrpBalanceRaw = await this.client.getXrpBalance(this.wallet.address);
      const xrpBalance = String(xrpBalanceRaw);

      let usdBalance = '0';
      const linesResponse = await this.client.request({
        command: 'account_lines',
        account: this.wallet.address
      });
      const usdLine = linesResponse.result.lines.find((line: any) => line.currency === 'USD' && line.account === this.usdIssuer);
      if (usdLine) {
        usdBalance = usdLine.balance;
      }

      db.logBalance(xrpBalance, usdBalance);

      // Calcular targets visuales para el panel
      const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
      let buyTarget = marketPrice * (1 - config.elphabaProfitFactor);
      let sellTarget = marketPrice;

      if (activeRungList.length > 0) {
        const highestRung = activeRungList.reduce((prev, curr) => (prev.sellPrice > curr.sellPrice) ? prev : curr);
        buyTarget = highestRung.buyPrice;
        sellTarget = highestRung.sellPrice * (1 + config.elphabaMarginRiseFactor);
      }

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: marketPrice.toString(),
        buyTarget: buyTarget.toString(),
        sellTarget: sellTarget.toString(),
        activeBuySeq: activeRungList.length > 0 ? `Buys Active: ${activeRungList.map(r => r.buySequence).join(', ')}` : 'Ninguna',
        activeSellSeq: activeRungList.length > 0 ? `Highest Sell: ${activeRungList[0].sellPrice.toFixed(4)}` : 'Ninguna',
        strategyName: 'Elphaba DCA Short',
        activeRungs: `${activeRungs} / ${config.maxRungs}`,
        botStatus: statusText
      });
    } catch (error) {
      log.error('Error al actualizar dashboard en Elphaba:', error);
    }
  }
}
