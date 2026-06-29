import { Client, Wallet, OfferCreate, OfferCancel, SubmittableTransaction, Amount } from 'xrpl';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('OrderManager');


export class XRPLOrderManager {
  private client: Client;
  private localSequenceMap: Map<string, number> = new Map();

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Envía una transacción al ledger de forma segura, encargándose de preparar,
   * autofirmar y enviar.
   */
  private async submitTransaction(wallet: Wallet, txJSON: SubmittableTransaction) {
    const walletAddress = wallet.address;
    try {
      // Asignar secuencia local si ya está mapeada para esta wallet
      if (this.localSequenceMap.has(walletAddress)) {
        txJSON.Sequence = this.localSequenceMap.get(walletAddress)!;
      }

      // 1. Preparar la transacción (completar campos de red como Sequence, Fee, LastLedgerSequence)
      const prepared = await this.client.autofill(txJSON);

      // Guardar e incrementar la secuencia local para el próximo envío asíncrono
      if (prepared.Sequence) {
        this.localSequenceMap.set(walletAddress, prepared.Sequence + 1);
      }

      // Verificar que la comisión no exceda el límite máximo configurado
      if (prepared.Fee) {
        const feeDrops = parseInt(prepared.Fee, 10);
        if (feeDrops > config.maxFeeDrops) {
          log.warn(`Transacción ${txJSON.TransactionType} abortada: La comisión requerida (${feeDrops} drops) supera el límite máximo permitido (${config.maxFeeDrops} drops).`);
          return { success: false, error: 'MAX_FEE_EXCEEDED' };
        }
      }
      
      // 2. Firmar localmente con las claves privadas de la billetera
      const signed = wallet.sign(prepared);
      
      // 3. Enviar transacción de forma asíncrona (HFT)
      log.debug(`Enviando transacción ${txJSON.TransactionType} asíncronamente (HFT)...`);
      const response = await this.client.submit(signed.tx_blob);
      
      const engineResult = response.result.engine_result;
      const isQueuedOrSuccess = engineResult === 'tesSUCCESS' || engineResult === 'terQUEUED';

      if (isQueuedOrSuccess) {
        log.info(`¡Transacción ${txJSON.TransactionType} enviada con éxito! (Resultado: ${engineResult})`);
        return {
          success: true,
          hash: response.result.tx_json.hash,
          sequence: response.result.tx_json.Sequence,
          result: response
        };
      } else {
        log.error(`Error inmediato en la transacción ${txJSON.TransactionType}: ${engineResult}`);
        // Limpiar secuencia local en caso de error para auto-corregir con la red en el siguiente envío
        this.localSequenceMap.delete(walletAddress);
        return { success: false, error: engineResult, result: response };
      }
    } catch (error) {
      log.error(`Excepción al enviar transacción ${txJSON.TransactionType}:`, error);
      this.localSequenceMap.delete(walletAddress);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Coloca una orden límite (OfferCreate) en el libro de órdenes del DEX.
   * @param wallet Billetera que coloca la oferta
   * @param takerPays Lo que el trader quiere RECIBIR (Comprar)
   * @param takerGets Lo que el trader ofrece PAGAR (Vender)
   */
  async createLimitOrder(wallet: Wallet, takerPays: Amount, takerGets: Amount) {
    const txJSON: OfferCreate = {
      TransactionType: 'OfferCreate',
      Account: wallet.address,
      TakerPays: takerPays,
      TakerGets: takerGets
    };

    return this.submitTransaction(wallet, txJSON);
  }

  /**
   * Coloca una orden de mercado (OfferCreate con flag ImmediateOrCancel).
   * Ejecuta inmediatamente el swap con lo que haya disponible en el libro de órdenes.
   * @param wallet Billetera que hace el swap
   * @param takerPays Lo que quiere recibir
   * @param takerGets Lo que ofrece a cambio
   */
  async createMarketOrder(wallet: Wallet, takerPays: Amount, takerGets: Amount) {
    const txJSON: OfferCreate = {
      TransactionType: 'OfferCreate',
      Account: wallet.address,
      TakerPays: takerPays,
      TakerGets: takerGets,
      Flags: 0x00080000 // Flag: tfImmediateOrCancel
    };

    return this.submitTransaction(wallet, txJSON);
  }

  /**
   * Cancela una orden límite abierta (OfferCancel).
   * @param wallet Billetera propietaria de la orden
   * @param offerSequence El número de secuencia (Sequence) de la transacción OfferCreate original
   */
  async cancelOrder(wallet: Wallet, offerSequence: number) {
    const txJSON: OfferCancel = {
      TransactionType: 'OfferCancel',
      Account: wallet.address,
      OfferSequence: offerSequence
    };

    return this.submitTransaction(wallet, txJSON);
  }

  /**
   * Envía cualquier transacción firmada de forma segura a través del gestor.
   */
  async submitGeneric(wallet: Wallet, txJSON: SubmittableTransaction) {
    return this.submitTransaction(wallet, txJSON);
  }
}
