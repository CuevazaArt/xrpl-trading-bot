import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';
import { config } from '../config.js';

const log = createLogger('DorothyStrategy');

interface DorothyRung {
  buySequence?: number;
  buyPrice: number;
  buyQty: number;
  sellSequence?: number;
  sellPrice: number;
  status: 'BUYING' | 'ACTIVE' | 'CLOSED' | 'ORPHANED';
  timestamp: number;
}

export class XRPLDorothyStrategy implements IStrategy {
  public readonly name = 'dorothy';

  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

  // Estado persistente en memoria para los rungs
  private rungs: DorothyRung[] = [];

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
      strategyName: 'Dorothy DCA Long'
    });

    log.info(`Dorothy inicializada con profit_factor=${config.dorothyProfitFactor}, margin_drop_factor=${config.dorothyMarginDropFactor}, max_rungs=${config.maxRungs}`);
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    // 1. Verificar fills y actualizar estado de rungs en base a las ofertas activas en el Ledger
    await this.syncRungsWithLedger();

    // 2. Determinar tendencia y compuertas de entrada usando datos de velas (ej: Binance API pública)
    const { trendOk, entryOk, candleOpen1h } = await this.checkTrendGates(marketPrice);
    
    const activeRungs = this.rungs.filter(r => r.status === 'ACTIVE').length;
    log.info(`Dorothy Estado: Rungs Activos = ${activeRungs}/${config.maxRungs} | Precio Mercado = ${marketPrice.toFixed(4)} USD`);
    log.info(`Dorothy Compuertas: Tendencia (Alcista) = ${trendOk ? 'OPEN' : 'BLOCKED'} | Entrada (Bajo Apertura 1h: ${candleOpen1h.toFixed(4)}) = ${entryOk ? 'OPEN' : 'BLOCKED'}`);

    this.updateDashboard(marketPrice, activeRungs, `Tendencia: ${trendOk ? 'ALCISTA' : 'BAJISTA'} | Entrada: ${entryOk ? 'OK' : 'BLOCKED'}`);

    // Si las compuertas de tendencia o entrada están bloqueadas, no realizamos nuevas compras
    if (!trendOk || !entryOk) {
      log.info('Ciclo de compra omitido por compuertas de tendencia/entrada.');
      return;
    }

    // 3. Evaluar lógica de compras DCA
    let shouldBuy = false;
    let lowestBuyPrice = 0;

    const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
    if (activeRungList.length === 0) {
      // Sin peldaños activos, podemos hacer la primera compra
      shouldBuy = true;
      log.info('Sin rungs activos. Iniciando primer peldaño de Dorothy...');
    } else {
      // Encontrar el precio de compra del peldaño más bajo
      const lowestRung = activeRungList.reduce((prev, curr) => (prev.buyPrice < curr.buyPrice) ? prev : curr);
      lowestBuyPrice = lowestRung.buyPrice;

      // Dorothy compra más abajo si cae el porcentaje marginDropFactor
      const triggerThreshold = lowestBuyPrice * (1 - config.dorothyMarginDropFactor);
      shouldBuy = marketPrice <= triggerThreshold;
      
      log.info(`Evaluando DCA: Precio más bajo = ${lowestBuyPrice.toFixed(4)} | Umbral disparo comp. = ${triggerThreshold.toFixed(4)} USD | Compra = ${shouldBuy}`);
    }

    // Comprobar techo de rungs
    if (shouldBuy && activeRungs >= config.maxRungs) {
      log.warn(`Techo de rungs alcanzado (${activeRungs}/${config.maxRungs}). Compra bloqueada.`);
      return;
    }

    if (shouldBuy) {
      await this.executeBuyAndPlaceTP(marketPrice);
    }
  }

  async cleanup(): Promise<void> {
    log.info('Cleanup: Dorothy mantendrá las órdenes límites de venta en el DEX para no perder rentabilidad.');
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
        if (rung.status === 'ACTIVE' && rung.sellSequence !== undefined) {
          // Si el sellSequence de nuestro Take Profit ya no está en las ofertas del Ledger, se ha llenado (FILLED)
          if (!activeSequences.has(rung.sellSequence)) {
            log.info(`¡Dorothy Rung llenado! Venta de Take Profit completada (Seq: ${rung.sellSequence}, Precio: ${rung.sellPrice} USD)`);
            rung.status = 'CLOSED';
            db.logTransaction('DOROTHY_TP_FILLED', '', 'FILLED', {
              buyPrice: rung.buyPrice,
              sellPrice: rung.sellPrice,
              qty: rung.buyQty
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
      log.error('Error al sincronizar rungs con Ledger (account_offers):', error);
    }
  }

  // =====================================================================
  // COMPUERTAS DE TENDENCIA (BINANCE API VELAS)
  // =====================================================================

  private async checkTrendGates(marketPrice: number): Promise<{ trendOk: boolean; entryOk: boolean; candleOpen1h: number }> {
    try {
      // Obtenemos las últimas 10 velas de 1h para XRP/USDT
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=10');
      if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
      const klines: any[] = await res.json();

      if (!klines || klines.length < 2) {
        return { trendOk: true, entryOk: true, candleOpen1h: marketPrice }; // Safe fallback
      }

      // Estructura de klines de Binance: [time, open, high, low, close, ...]
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

      // Última vela HA y penúltima
      const lastHA = haCandles[haCandles.length - 1];
      
      // Dorothy requiere tendencia alcista: HA Close > HA Open
      const trendOk = lastHA.haClose > lastHA.haOpen;

      // Compuerta de Entrada: Precio actual < Apertura de la última vela de 1h regular (comprar la caída)
      const lastRegularOpen = parseFloat(klines[klines.length - 1][1]);
      const entryOk = marketPrice < lastRegularOpen;

      return {
        trendOk,
        entryOk,
        candleOpen1h: lastRegularOpen
      };
    } catch (error) {
      log.warn('Error al verificar compuertas de tendencia (usando fallbacks permisivos):', (error as any).message);
      return { trendOk: true, entryOk: true, candleOpen1h: marketPrice };
    }
  }

  // =====================================================================
  // EJECUCIÓN DE COMPRA Y COLOCACIÓN DE TAKE PROFIT
  // =====================================================================

  private async executeBuyAndPlaceTP(marketPrice: number) {
    const buyQtyXrp = parseFloat(config.rungQtyXrp);
    
    // Simular compra a mercado: ofertamos comprar XRP pagando USD a un precio ligeramente mayor (ej: +1%)
    // para asegurar llenado inmediato. XRPL se encargará de emparejarlo al mejor precio del libro.
    const maxBuyPrice = marketPrice * 1.01; 
    const usdCost = (buyQtyXrp * maxBuyPrice).toFixed(4);

    const takerPays = (buyQtyXrp * 1000000).toString(); // XRP en drops
    const takerGets = {
      currency: 'USD',
      value: usdCost,
      issuer: this.usdIssuer
    };

    log.info(`Dorothy DCA: Comprando ${buyQtyXrp} XRP a mercado (Límite: ${maxBuyPrice.toFixed(4)} USD)`);

    try {
      const buyResult = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (!buyResult.success || !buyResult.sequence) {
        log.error('Dorothy: Falló orden de compra inicial.', buyResult.error);
        db.logTransaction('DOROTHY_COMPRA_FALLIDA', '', buyResult.error || 'ERROR', { qty: buyQtyXrp });
        return;
      }

      // Registro compra
      db.logTransaction('DOROTHY_COMPRA', buyResult.hash || '', 'tesSUCCESS', { price: marketPrice, amount: buyQtyXrp });

      // Colocar Take Profit (Venta Límite de XRP por USD con incremento)
      const sellPrice = parseFloat((marketPrice * (1 + config.dorothyProfitFactor)).toFixed(4));
      const sellUsdValue = (buyQtyXrp * sellPrice).toFixed(4);

      const sellTakerPays = {
        currency: 'USD',
        value: sellUsdValue,
        issuer: this.usdIssuer
      };
      const sellTakerGets = (buyQtyXrp * 1000000).toString(); // XRP en drops

      log.info(`Dorothy TP: Colocando venta límite de ${buyQtyXrp} XRP a ${sellPrice.toFixed(4)} USD (Valor: ${sellUsdValue} USD)`);

      const sellResult = await this.orderManager.createLimitOrder(this.wallet, sellTakerPays, sellTakerGets);

      if (sellResult.success && sellResult.sequence !== undefined) {
        // Añadir Rung activo
        const newRung: DorothyRung = {
          buyPrice: marketPrice,
          buyQty: buyQtyXrp,
          buySequence: buyResult.sequence,
          sellSequence: sellResult.sequence,
          sellPrice: sellPrice,
          status: 'ACTIVE',
          timestamp: Date.now()
        };
        this.rungs.push(newRung);
        this.saveStateToDB();

        db.logTransaction('DOROTHY_TP_LIMIT', sellResult.hash || '', 'tesSUCCESS', { price: sellPrice, amount: buyQtyXrp });
      } else {
        // Alerta crítica: compra exitosa pero venta falló (posición huérfana)
        log.error(`¡DOROTHY POSICIÓN HUÉRFANA! Compra exitosa (Seq: ${buyResult.sequence}) pero Venta falló: ${sellResult.error}`);
        const newRung: DorothyRung = {
          buyPrice: marketPrice,
          buyQty: buyQtyXrp,
          buySequence: buyResult.sequence,
          sellPrice: sellPrice,
          status: 'ORPHANED',
          timestamp: Date.now()
        };
        this.rungs.push(newRung);
        this.saveStateToDB();
        db.logTransaction('DOROTHY_TP_FALLIDA_HUERFANA', '', sellResult.error || 'ERROR_TP', { buyPrice: marketPrice });
      }
    } catch (error) {
      log.error('Excepción crítica en executeBuyAndPlaceTP de Dorothy:', error);
    }
  }

  // =====================================================================
  // PERSISTENCIA LOCAL DE ESTADO
  // =====================================================================

  private saveStateToDB() {
    try {
      // Guardar el estado de los rungs en la base de datos JSON local
      db.saveCustomData('dorothy_rungs', this.rungs);
    } catch (error) {
      log.error('Error al guardar estado de Dorothy en DB:', error);
    }
  }

  private loadStateFromDB() {
    try {
      const saved = db.getCustomData('dorothy_rungs');
      if (Array.isArray(saved)) {
        this.rungs = saved;
        log.info(`Dorothy: Recuperados ${this.rungs.length} rungs previos de la DB.`);
      }
    } catch (error) {
      log.error('Error al cargar estado de Dorothy de DB:', error);
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

      // Calcular bid/ask del rung más bajo como targets visuales
      const activeRungList = this.rungs.filter(r => r.status === 'ACTIVE');
      let buyTarget = marketPrice;
      let sellTarget = marketPrice * (1 + config.dorothyProfitFactor);

      if (activeRungList.length > 0) {
        const lowestRung = activeRungList.reduce((prev, curr) => (prev.buyPrice < curr.buyPrice) ? prev : curr);
        buyTarget = lowestRung.buyPrice * (1 - config.dorothyMarginDropFactor);
        sellTarget = lowestRung.sellPrice;
      }

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: marketPrice.toString(),
        buyTarget: buyTarget.toString(),
        sellTarget: sellTarget.toString(),
        activeBuySeq: activeRungList.length > 0 ? `Lowest Buy: ${activeRungList[0].buyPrice.toFixed(4)}` : 'Ninguna',
        activeSellSeq: activeRungList.length > 0 ? `Sells Active: ${activeRungList.map(r => r.sellSequence).join(', ')}` : 'Ninguna',
        strategyName: 'Dorothy DCA Long',
        activeRungs: `${activeRungs} / ${config.maxRungs}`,
        botStatus: statusText
      });
    } catch (error) {
      log.error('Error al actualizar dashboard en Dorothy:', error);
    }
  }
}
