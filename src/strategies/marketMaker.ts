import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';
import { db } from '../db.js';
import { createLogger } from '../logger.js';
import { IStrategy } from './IStrategy.js';

const log = createLogger('MarketMakerStrategy');

interface ActiveOrder {
  sequence: number;
  price: number;
  ledgerPlaced: number;
}

export class XRPLMarketMakerStrategy implements IStrategy {
  public readonly name = 'market_maker';
  
  private client!: Client;
  private wallet!: Wallet;
  private orderManager!: XRPLOrderManager;
  private dashboard!: XRPLDashboard;

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
  private lastReplaceLedger: number = 0;
  private currentLedger: number = 0;

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

    this.dashboard.updateState({
      walletAddress: wallet.address,
      strategyName: 'Market Maker (MM)'
    });
  }

  async tick(currentLedger: number, marketPrice: number): Promise<void> {
    this.currentLedger = currentLedger;

    // 1. Detectar fills: verificar si nuestras órdenes siguen activas en el DEX
    await this.checkForFills();

    // 2. Usar los precios obtenidos del oráculo/mercado
    const bestBid = marketPrice * 0.999;
    const bestAsk = marketPrice * 1.001;
    const midPrice = marketPrice;

    log.info(`MM Precios: Bid=${bestBid.toFixed(4)} | Ask=${bestAsk.toFixed(4)} | Medio=${midPrice.toFixed(4)} USD`);

    // 3. Calcular spread dinámico basado en volatilidad
    const dynamicSpread = this.calculateDynamicSpread(midPrice);
    log.debug(`MM Spread dinámico: ${(dynamicSpread * 100).toFixed(2)}%`);

    // 4. Calcular sesgo de inventario
    const inventoryBias = await this.calculateInventoryBias();
    log.debug(`MM Sesgo de inventario: ${(inventoryBias * 100).toFixed(2)}%`);

    // 5. Calcular precios objetivo con spread + sesgo
    const targetBuyPrice = midPrice * (1 - dynamicSpread / 2 + inventoryBias);
    const targetSellPrice = midPrice * (1 + dynamicSpread / 2 + inventoryBias);

    log.info(`MM Objetivos: Compra=${targetBuyPrice.toFixed(4)} | Venta=${targetSellPrice.toFixed(4)} USD`);

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

  async cleanup(): Promise<void> {
    log.info('Limpiando órdenes activas de Market Maker...');
    await this.cancelActiveOrders();
  }

  // =====================================================================
  // DETECCIÓN DE FILLS
  // =====================================================================

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

  private calculateDynamicSpread(currentPrice: number): number {
    if (this.lastPrice === 0) {
      return this.baseSpread;
    }

    const priceChange = Math.abs(currentPrice - this.lastPrice) / this.lastPrice;
    const volatilityAdjustment = priceChange * 10;
    const dynamicSpread = this.baseSpread + volatilityAdjustment;

    return Math.max(this.minSpread, Math.min(this.maxSpread, dynamicSpread));
  }

  // =====================================================================
  // GESTIÓN DE INVENTARIO
  // =====================================================================

  private async calculateInventoryBias(): Promise<number> {
    try {
      const xrpBalanceNum = await this.client.getXrpBalance(this.wallet.address);
      const xrpNum = typeof xrpBalanceNum === 'string' ? parseFloat(xrpBalanceNum) : xrpBalanceNum;

      const deviation = (xrpNum - this.targetPositionXRP) / this.maxPositionXRP;
      const bias = deviation * 0.005; // Max 0.5% sesgo

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

  private async placeBuyOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = (xrpAmount * 1000000).toString(); // XRP en drops
    const takerGets = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };

    log.info(`Colocando COMPRA MM: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Costo: ${usdValue} USD)`);
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

  private async placeSellOrder(priceUsd: number) {
    const xrpAmount = parseFloat(this.orderAmountXRP);
    const usdValue = (xrpAmount * priceUsd).toFixed(4);

    const takerPays = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };
    const takerGets = (xrpAmount * 1000000).toString(); // XRP en drops

    log.info(`Colocando VENTA MM: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Retorno: ${usdValue} USD)`);
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

      db.logBalance(xrpBalance, usdBalance);

      this.dashboard.updateState({
        xrpBalance,
        usdBalance,
        midPrice: midPrice.toString(),
        buyTarget: buyTarget.toString(),
        sellTarget: sellTarget.toString(),
        activeBuySeq: this.activeBuy !== null ? this.activeBuy.sequence.toString() : 'Ninguna',
        activeSellSeq: this.activeSell !== null ? this.activeSell.sequence.toString() : 'Ninguna',
        strategyName: 'Market Maker (MM)',
        activeRungs: 'N/A (MM)',
        botStatus: 'Operando normalmente'
      });
    } catch (error) {
      log.error('Error al actualizar balances en el dashboard:', error);
    }
  }
}
