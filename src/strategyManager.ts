import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { db } from './db.js';
import { XRPLDashboard } from './dashboard.js';
import { createLogger } from './logger.js';

const log = createLogger('Strategy');

interface ActiveOrder {
  sequence: number;
  price: number;       // Precio al que se colocó
  ledgerPlaced: number; // Ledger en el que se colocó
}

export class XRPLStrategyManager {
  private client: Client;
  private wallet: Wallet;
  private orderManager: XRPLOrderManager;
  private dashboard: XRPLDashboard;

  // === Parámetros de la estrategia ===
  private baseSpread = 0.01;        // 1% base spread
  private minSpread = 0.005;        // 0.5% mínimo
  private maxSpread = 0.02;         // 2% máximo
  private orderAmountXRP = '10';    // Comerciar de a 10 XRP
  private priceDeviationThreshold = 0.003; // 0.3% desviación para recolocar
  private cooldownLedgers = 3;      // Mínimo de 3 ledgers entre recolocaciones
  private maxPositionXRP = 80;      // Máximo de XRP que queremos mantener
  private targetPositionXRP = 50;   // Posición neutral objetivo

  // === Estado de órdenes activas ===
  private activeBuy: ActiveOrder | null = null;
  private activeSell: ActiveOrder | null = null;

  // === Estado de tracking ===
  private lastPrice: number = 0;
  private currentLedger: number = 0;
  private lastReplaceLedger: number = 0;    // Último ledger donde se hizo cancel/replace
  private tickCount: number = 0;

  // Emisor de USD
  private usdIssuer = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

  constructor(client: Client, wallet: Wallet, dashboard: XRPLDashboard) {
    this.client = client;
    this.wallet = wallet;
    this.dashboard = dashboard;
    this.orderManager = new XRPLOrderManager(client);

    // Inicializar dirección en el dashboard
    this.dashboard.updateState({
      walletAddress: wallet.address
    });
  }

  /**
   * Arranca la estrategia escuchando cierres de ledgers y tomando decisiones
   */
  async start() {
    log.info('Iniciando Estrategia de Market Making XRP/USD...');

    // Suscribirse al stream de ledgers para que este cliente reciba los eventos
    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger']
      });
    } catch (error) {
      log.error('Error al suscribirse al stream de ledgers en la estrategia:', error);
    }

    // Escuchar cierres de ledger para ejecutar la reevaluación periódica
    this.client.connection.on('ledgerClosed', async (ledger) => {
      this.currentLedger = ledger.ledger_index;
      this.tickCount++;
      log.info(`--- Tick #${this.tickCount} en Ledger #${this.currentLedger} ---`);
      try {
        await this.tick();
      } catch (error) {
        log.error('Error durante el ciclo de estrategia (tick):', error);
      }
    });
  }

  /**
   * Ciclo principal ejecutado en cada bloque
   */
  private async tick() {
    // 1. Detectar fills: verificar si nuestras órdenes siguen activas en el DEX
    await this.checkForFills();

    // 2. Consultar precio de referencia
    const prices = await this.getMarketPrices();
    if (!prices) {
      log.warn('No se pudieron calcular precios del libro. Saltando ciclo...');
      return;
    }

    const { bestBid, bestAsk, midPrice } = prices;
    log.info(`Precios: Bid=${bestBid.toFixed(4)} | Ask=${bestAsk.toFixed(4)} | Medio=${midPrice.toFixed(4)} USD`);

    // 3. Calcular spread dinámico basado en volatilidad
    const dynamicSpread = this.calculateDynamicSpread(midPrice);
    log.debug(`Spread dinámico: ${(dynamicSpread * 100).toFixed(2)}%`);

    // 4. Calcular sesgo de inventario
    const inventoryBias = await this.calculateInventoryBias();
    log.debug(`Sesgo de inventario: ${(inventoryBias * 100).toFixed(2)}%`);

    // 5. Calcular precios objetivo con spread + sesgo
    const targetBuyPrice = midPrice * (1 - dynamicSpread / 2 + inventoryBias);
    const targetSellPrice = midPrice * (1 + dynamicSpread / 2 + inventoryBias);

    log.info(`Objetivos: Compra=${targetBuyPrice.toFixed(4)} | Venta=${targetSellPrice.toFixed(4)} USD`);

    // 6. ¿Debemos cancelar y recolocar?
    const shouldReplace = this.shouldReplaceOrders(midPrice, targetBuyPrice, targetSellPrice);

    if (shouldReplace) {
      // Cancelar órdenes activas
      await this.cancelActiveOrders();
      
      // Colocar nuevas órdenes
      await this.placeBuyOrder(targetBuyPrice);
      await this.placeSellOrder(targetSellPrice);
      
      this.lastReplaceLedger = this.currentLedger;
    } else {
      // Colocar solo las que falten (fueron filled o nunca se colocaron)
      if (this.activeBuy === null) {
        await this.placeBuyOrder(targetBuyPrice);
      }
      if (this.activeSell === null) {
        await this.placeSellOrder(targetSellPrice);
      }
    }

    // 7. Actualizar métricas
    this.lastPrice = midPrice;
    await this.updateBalancesAndDashboard(midPrice, targetBuyPrice, targetSellPrice);
  }

  // =====================================================================
  // DETECCIÓN DE FILLS
  // =====================================================================

  /**
   * Consulta account_offers para verificar si nuestras órdenes siguen vivas.
   * Si una secuencia ya no aparece en las ofertas activas, fue ejecutada (filled).
   */
  private async checkForFills() {
    try {
      const response = await this.client.request({
        command: 'account_offers',
        account: this.wallet.address,
      });
      
      const activeSequences = new Set(
        response.result.offers?.map((offer: any) => offer.seq) || []
      );

      if (this.activeBuy && !activeSequences.has(this.activeBuy.sequence)) {
        log.info(`¡Orden de COMPRA (Seq: ${this.activeBuy.sequence}) fue ejecutada (FILLED)!`);
        db.logTransaction('COMPRA_FILLED', '', 'FILLED', {
          sequence: this.activeBuy.sequence,
          price: this.activeBuy.price
        });
        this.activeBuy = null;
      }

      if (this.activeSell && !activeSequences.has(this.activeSell.sequence)) {
        log.info(`¡Orden de VENTA (Seq: ${this.activeSell.sequence}) fue ejecutada (FILLED)!`);
        db.logTransaction('VENTA_FILLED', '', 'FILLED', {
          sequence: this.activeSell.sequence,
          price: this.activeSell.price
        });
        this.activeSell = null;
      }
    } catch (error) {
      log.error('Error al verificar fills (account_offers):', error);
    }
  }

  // =====================================================================
  // DECISIÓN DE CANCEL/REPLACE
  // =====================================================================

  /**
   * Decide si debemos cancelar y recolocar las órdenes.
   * Condiciones:
   * - El precio se desvió más del threshold respecto al precio de la orden activa
   * - Han pasado al menos `cooldownLedgers` desde la última recolocación
   */
  private shouldReplaceOrders(currentPrice: number, _targetBuy: number, _targetSell: number): boolean {
    // Respetar cooldown
    if (this.currentLedger - this.lastReplaceLedger < this.cooldownLedgers) {
      return false;
    }

    // Si no hay órdenes activas, no hay nada que reemplazar
    if (this.activeBuy === null && this.activeSell === null) {
      return false;
    }

    // Verificar desviación de precio
    if (this.activeBuy) {
      const buyDeviation = Math.abs(currentPrice - this.activeBuy.price) / this.activeBuy.price;
      if (buyDeviation > this.priceDeviationThreshold) {
        log.info(`Desviación de compra: ${(buyDeviation * 100).toFixed(2)}% > ${(this.priceDeviationThreshold * 100).toFixed(2)}% → Recolocando`);
        return true;
      }
    }

    if (this.activeSell) {
      const sellDeviation = Math.abs(currentPrice - this.activeSell.price) / this.activeSell.price;
      if (sellDeviation > this.priceDeviationThreshold) {
        log.info(`Desviación de venta: ${(sellDeviation * 100).toFixed(2)}% > ${(this.priceDeviationThreshold * 100).toFixed(2)}% → Recolocando`);
        return true;
      }
    }

    return false;
  }

  // =====================================================================
  // SPREAD DINÁMICO
  // =====================================================================

  /**
   * Calcula un spread dinámico basado en la volatilidad observada.
   * Si el precio se movió mucho desde el último tick, ampliamos el spread.
   */
  private calculateDynamicSpread(currentPrice: number): number {
    if (this.lastPrice === 0) {
      return this.baseSpread;
    }

    const priceChange = Math.abs(currentPrice - this.lastPrice) / this.lastPrice;
    
    // Amplificar el spread por 10x la volatilidad observada
    const volatilityAdjustment = priceChange * 10;
    const dynamicSpread = this.baseSpread + volatilityAdjustment;

    // Clampar entre min y max
    return Math.max(this.minSpread, Math.min(this.maxSpread, dynamicSpread));
  }

  // =====================================================================
  // GESTIÓN DE INVENTARIO
  // =====================================================================

  /**
   * Calcula un sesgo de precio basado en la posición de inventario.
   * Si tenemos demasiado XRP, sesgamos el precio para vender más.
   * Si tenemos poco XRP, sesgamos para comprar más.
   * Retorna un valor entre -0.005 y +0.005 (0.5% máximo sesgo).
   */
  private async calculateInventoryBias(): Promise<number> {
    try {
      const xrpBalanceNum = await this.client.getXrpBalance(this.wallet.address);
      const xrpNum = typeof xrpBalanceNum === 'string' ? parseFloat(xrpBalanceNum) : xrpBalanceNum;

      // Calcular desviación del objetivo (normalizada)
      const deviation = (xrpNum - this.targetPositionXRP) / this.maxPositionXRP;

      // Sesgo: positivo = subir precios (vender más barato para reducir XRP)
      //        negativo = bajar precios (comprar más barato para acumular XRP)
      const bias = deviation * 0.005; // Max 0.5% de sesgo

      return Math.max(-0.005, Math.min(0.005, bias));
    } catch {
      return 0;
    }
  }

  // =====================================================================
  // GESTIÓN DE ÓRDENES
  // =====================================================================

  /**
   * Cancela todas las órdenes activas de forma limpia
   */
  private async cancelActiveOrders() {
    if (this.activeBuy) {
      log.info(`Cancelando orden de compra activa (Seq: ${this.activeBuy.sequence})...`);
      try {
        const result = await this.orderManager.cancelOrder(this.wallet, this.activeBuy.sequence);
        db.logTransaction('CANCELAR_COMPRA', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), {
          sequence: this.activeBuy.sequence
        });
      } catch (error) {
        log.error('Error al cancelar orden de compra:', error);
      }
      this.activeBuy = null;
    }

    if (this.activeSell) {
      log.info(`Cancelando orden de venta activa (Seq: ${this.activeSell.sequence})...`);
      try {
        const result = await this.orderManager.cancelOrder(this.wallet, this.activeSell.sequence);
        db.logTransaction('CANCELAR_VENTA', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), {
          sequence: this.activeSell.sequence
        });
      } catch (error) {
        log.error('Error al cancelar orden de venta:', error);
      }
      this.activeSell = null;
    }
  }

  /**
   * Coloca una orden límite de compra (intercambiar USD por XRP)
   */
  private async placeBuyOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = (xrpAmount * 1000000).toString(); // XRP en drops
    const takerGets = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };

    log.info(`Colocando COMPRA: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Costo: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (result.success && result.sequence !== undefined) {
        this.activeBuy = {
          sequence: result.sequence,
          price: priceUsd,
          ledgerPlaced: this.currentLedger,
        };
        db.logTransaction('COMPRA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount });
      } else {
        db.logTransaction('COMPRA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
      }
    } catch (error) {
      log.error('Excepción al colocar orden de compra:', error);
    }
  }

  /**
   * Coloca una orden límite de venta (intercambiar XRP por USD)
   */
  private async placeSellOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };
    const takerGets = (xrpAmount * 1000000).toString(); // XRP en drops

    log.info(`Colocando VENTA: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Retorno: ${usdValue} USD)`);
    try {
      const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
      
      if (result.success && result.sequence !== undefined) {
        this.activeSell = {
          sequence: result.sequence,
          price: priceUsd,
          ledgerPlaced: this.currentLedger,
        };
        db.logTransaction('VENTA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount });
      } else {
        db.logTransaction('VENTA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
      }
    } catch (error) {
      log.error('Excepción al colocar orden de venta:', error);
    }
  }

  // =====================================================================
  // ORÁCULO DE PRECIOS
  // =====================================================================

  /**
   * Consulta el precio real de mercado (spot) de XRP/USD desde la API pública de Coinbase
   * para usarlo como precio justo de referencia, evitando el spam y las ofertas sin fondos de Testnet.
   */
  private async getFairPrice(): Promise<number> {
    try {
      const response = await fetch('https://api.coinbase.com/v2/prices/XRP-USD/spot');
      if (!response.ok) {
        throw new Error(`Coinbase API returned status ${response.status}`);
      }
      const data: any = await response.json();
      const price = parseFloat(data.data.amount);
      if (!isNaN(price) && price > 0) {
        return price;
      }
      return 0.50; // Fallback
    } catch (error) {
      log.warn('No se pudo obtener el precio de Coinbase. Usando fallback (0.50 USD).', (error as any).message);
      return 0.50;
    }
  }

  /**
   * Genera los precios de Bid/Ask alrededor del precio justo de referencia
   */
  private async getMarketPrices() {
    const fairPrice = await this.getFairPrice();
    log.debug(`[ORÁCULO] Precio Justo (Coinbase): ${fairPrice.toFixed(4)} USD`);

    // Establecemos Bid y Ask simulando un libro alrededor del precio de referencia
    const bestBid = fairPrice * 0.999; // 0.1% abajo
    const bestAsk = fairPrice * 1.001; // 0.1% arriba
    const midPrice = fairPrice;

    return { bestBid, bestAsk, midPrice };
  }

  // =====================================================================
  // DASHBOARD Y MÉTRICAS
  // =====================================================================

  /**
   * Obtiene balances y actualiza la base de datos y la interfaz en tiempo real
   */
  private async updateBalancesAndDashboard(midPrice: number, buyTarget: number, sellTarget: number) {
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

      // Guardar en Base de Datos
      db.logBalance(xrpBalance, usdBalance);

      // Reportar al Dashboard
      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: midPrice.toString(),
        buyTarget: buyTarget.toString(),
        sellTarget: sellTarget.toString(),
        activeBuySeq: this.activeBuy !== null ? this.activeBuy.sequence.toString() : 'Ninguna',
        activeSellSeq: this.activeSell !== null ? this.activeSell.sequence.toString() : 'Ninguna'
      });
    } catch (error) {
      log.error('Error al actualizar balances en el dashboard:', error);
    }
  }

  /**
   * Cancela todas las órdenes activas en apagado
   */
  async cancelAllOrders() {
    log.info('Cancelando órdenes de la estrategia antes de apagar...');
    await this.cancelActiveOrders();
    log.info('Órdenes canceladas.');
  }
}
