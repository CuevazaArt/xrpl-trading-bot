import { Client, Wallet, TrustSet } from 'xrpl';
import { XRPLOrderManager } from './orderManager.js';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('TrustlineManager');

export class XRPLTrustlineManager {
  private client: Client;
  private usdIssuer = config.usdIssuer;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Verifica si la cuenta ya tiene la Trustline configurada para USD.
   * Si no la tiene, crea una transacción TrustSet para establecerla.
   */
  async ensureUsdTrustline(wallet: Wallet): Promise<boolean> {
    log.info(`Verificando línea de confianza (Trustline) para USD (Emisor: ${this.usdIssuer})...`);
    try {
      const response = await this.client.request({
        command: 'account_lines',
        account: wallet.address,
      });

      const lines = response.result.lines || [];
      const hasTrustline = lines.some(
        (line: any) => line.currency === 'USD' && line.account === this.usdIssuer
      );

      if (hasTrustline) {
        log.info('Línea de confianza USD ya activa.');
        return true;
      }

      log.info('No se encontró línea de confianza USD. Creando TrustSet...');
      
      const trustSetTx: TrustSet = {
        TransactionType: 'TrustSet',
        Account: wallet.address,
        LimitAmount: {
          currency: 'USD',
          issuer: this.usdIssuer,
          value: '1000000' // Límite de confianza máximo permitido (1 millón USD)
        }
      };

      const prepared = await this.client.autofill(trustSetTx);
      const signed = wallet.sign(prepared);
      log.debug('Enviando transacción TrustSet...');
      const result = await this.client.submitAndWait(signed.tx_blob);

      const txResult = (result.result.meta as any)?.TransactionResult;
      if (txResult === 'tesSUCCESS') {
        log.info('¡Línea de confianza USD creada con éxito!');
        return true;
      } else {
        log.error(`Error al crear la línea de confianza: ${txResult}`);
        return false;
      }
    } catch (error) {
      log.error('Excepción al configurar la línea de confianza:', error);
      return false;
    }
  }

  /**
   * Realiza un swap inicial vendiendo XRP para comprar USD.
   * Esto nos proveerá de USD iniciales para poder operar en ambas direcciones.
   */
  async performInitialSwap(wallet: Wallet, xrpToSell: number, expectedUsdPrice: number) {
    log.info(`Ejecutando swap inicial: Vendiendo ${xrpToSell} XRP para comprar USD...`);
    
    const orderManager = new XRPLOrderManager(this.client);
    
    // TakerGets: Lo que damos (XRP en drops)
    const takerGets = (xrpToSell * 1000000).toString();
    
    // TakerPays: Lo que queremos recibir (USD)
    // Estimamos recibir XRP * expectedUsdPrice USD (ej. 20 XRP * 1 USD = 20 USD)
    const usdValue = (xrpToSell * expectedUsdPrice * 0.95).toFixed(4); // 5% slippage tolerance
    const takerPays = {
      currency: 'USD',
      value: usdValue,
      issuer: this.usdIssuer
    };

    try {
      log.debug(`Enviando orden de mercado para obtener al menos ${usdValue} USD...`);
      const result = await orderManager.createMarketOrder(wallet, takerPays, takerGets);
      if (result.success) {
        log.info(`¡Swap inicial completado! Hash: ${result.hash}`);
      } else {
        log.warn(`No se pudo realizar el swap inicial: ${result.error}. Es posible que no haya liquidez en el DEX de Testnet.`);
      }
    } catch (error) {
      log.error('Error durante el swap inicial:', error);
    }
  }
}
