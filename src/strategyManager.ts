import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { db } from './db.js';
import { XRPLDashboard } from './dashboard.js';

export class XRPLStrategyManager {
  private client: Client;
  private wallet: Wallet;
  private orderManager: XRPLOrderManager;
  private dashboard: XRPLDashboard;

  // Parámetros de la estrategia
  private targetSpread = 0.01; // 1% de spread objetivo
  private orderAmountXRP = '10'; // Comerciar de a 10 XRP

  // Registro de órdenes activas (secuencias)
  private activeBuySeq: number | null = null;
  private activeSellSeq: number | null = null;

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
    console.log('Iniciando Estrategia de Market Making XRP/USD...');

    // Suscribirse al stream de ledgers para que este cliente reciba los eventos
    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger']
      });
    } catch (error) {
      console.error('Error al suscribirse al stream de ledgers en la estrategia:', error);
    }

    // Escuchar cierres de ledger para ejecutar la reevaluación periódica
    this.client.connection.on('ledgerClosed', async (ledger) => {
      console.log(`\n--- Reevaluando Estrategia en Ledger #${ledger.ledger_index} ---`);
      try {
        await this.tick();
      } catch (error) {
        console.error('Error durante el ciclo de estrategia (tick):', error);
      }
    });
  }

  /**
   * Ciclo principal ejecutado en cada bloque
   */
  private async tick() {
    // 1. Consultar el estado del libro de órdenes
    const prices = await this.getMarketPrices();
    if (!prices) {
      console.log('No se pudieron calcular precios del libro. Saltando ciclo...');
      return;
    }

    const { bestBid, bestAsk, midPrice } = prices;
    console.log(`Precios de Referencia: Bid=${bestBid.toFixed(4)} USD | Ask=${bestAsk.toFixed(4)} USD | Medio=${midPrice.toFixed(4)} USD`);

    // 2. Calcular precios objetivo para nuestras órdenes
    // Compra: un poco por debajo del precio medio
    const targetBuyPrice = midPrice * (1 - this.targetSpread / 2);
    // Venta: un poco por encima del precio medio
    const targetSellPrice = midPrice * (1 + this.targetSpread / 2);

    console.log(`Precios Objetivo: Compra=${targetBuyPrice.toFixed(4)} USD | Venta=${targetSellPrice.toFixed(4)} USD`);

    // 3. Gestionar orden de COMPRA (DEX)
    if (this.activeBuySeq === null) {
      await this.placeBuyOrder(targetBuyPrice);
    } else {
      console.log(`Orden de compra ya activa (Secuencia: ${this.activeBuySeq}). Manteniendo posición.`);
    }

    // 4. Gestionar orden de VENTA (DEX)
    if (this.activeSellSeq === null) {
      await this.placeSellOrder(targetSellPrice);
    } else {
      console.log(`Orden de venta ya activa (Secuencia: ${this.activeSellSeq}). Manteniendo posición.`);
    }

    // 5. Actualizar balances e informes en el dashboard
    await this.updateBalancesAndDashboard(midPrice, targetBuyPrice, targetSellPrice);
  }

  /**
   * Obtiene balances y actualiza la base de datos y la interfaz en tiempo real
   */
  private async updateBalancesAndDashboard(midPrice: number, buyTarget: number, sellTarget: number) {
    try {
      const xrpBalance = await this.client.getXrpBalance(this.wallet.address);
      
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
        activeBuySeq: this.activeBuySeq !== null ? this.activeBuySeq.toString() : 'Ninguna',
        activeSellSeq: this.activeSellSeq !== null ? this.activeSellSeq.toString() : 'Ninguna'
      });
    } catch (error) {
      console.error('Error al actualizar balances en el dashboard:', error);
    }
  }

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
      console.warn('No se pudo obtener el precio de Coinbase. Usando precio de fallback (0.50 USD). Error:', (error as any).message);
      return 0.50;
    }
  }

  /**
   * Genera los precios de Bid/Ask alrededor del precio justo de referencia
   */
  private async getMarketPrices() {
    const fairPrice = await this.getFairPrice();
    console.log(`[ORÁCULO] Precio Justo de Referencia (Coinbase): ${fairPrice.toFixed(4)} USD`);

    // Establecemos Bid y Ask simulando un libro alrededor del precio de referencia
    const bestBid = fairPrice * 0.999; // 0.1% abajo
    const bestAsk = fairPrice * 1.001; // 0.1% arriba
    const midPrice = fairPrice;

    return { bestBid, bestAsk, midPrice };
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

    console.log(`Colocando nueva orden de compra: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Costo: ${usdValue} USD)`);
    const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
    
    if (result.success && result.sequence !== undefined) {
      this.activeBuySeq = result.sequence;
      db.logTransaction('COMPRA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount });
    } else {
      db.logTransaction('COMPRA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
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

    console.log(`Colocando nueva orden de venta: ${xrpAmount} XRP a ${priceUsd.toFixed(4)} USD (Retorno: ${usdValue} USD)`);
    const result = await this.orderManager.createLimitOrder(this.wallet, takerPays, takerGets);
    
    if (result.success && result.sequence !== undefined) {
      this.activeSellSeq = result.sequence;
      db.logTransaction('VENTA_LIMITE', result.hash || '', 'tesSUCCESS', { price: priceUsd, amount: xrpAmount });
    } else {
      db.logTransaction('VENTA_LIMITE', '', result.error || 'ERROR_DESCONOCIDO', { price: priceUsd, amount: xrpAmount });
    }
  }

  /**
   * Cancela todas las órdenes activas en apagado
   */
  async cancelAllOrders() {
    console.log('Cancelando órdenes de la estrategia antes de apagar...');
    if (this.activeBuySeq !== null) {
      const result = await this.orderManager.cancelOrder(this.wallet, this.activeBuySeq);
      db.logTransaction('CANCELAR', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), { sequence: this.activeBuySeq });
      this.activeBuySeq = null;
    }
    if (this.activeSellSeq !== null) {
      const result = await this.orderManager.cancelOrder(this.wallet, this.activeSellSeq);
      db.logTransaction('CANCELAR', result.hash || '', result.success ? 'tesSUCCESS' : (result.error || 'ERROR'), { sequence: this.activeSellSeq });
      this.activeSellSeq = null;
    }
    console.log('Órdenes canceladas.');
  }
}
