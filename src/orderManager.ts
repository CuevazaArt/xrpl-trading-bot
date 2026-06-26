import { Client, Wallet, OfferCreate, OfferCancel, SubmittableTransaction, Amount } from 'xrpl';

export class XRPLOrderManager {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Envía una transacción al ledger de forma segura, encargándose de preparar,
   * autofirmar y enviar.
   */
  private async submitTransaction(wallet: Wallet, txJSON: SubmittableTransaction) {
    try {
      // 1. Preparar la transacción (completar campos de red como Sequence, Fee, LastLedgerSequence)
      const prepared = await this.client.autofill(txJSON);
      
      // 2. Firmar localmente con las claves privadas de la billetera
      const signed = wallet.sign(prepared);
      
      // 3. Enviar y esperar a que sea validada en un ledger cerrado
      console.log(`Enviando transacción ${txJSON.TransactionType}...`);
      const result = await this.client.submitAndWait(signed.tx_blob);
      
      const txResult = (result.result.meta as any)?.TransactionResult;
      if (txResult === 'tesSUCCESS') {
        console.log(`¡Transacción ${txJSON.TransactionType} exitosa!`);
        console.log(`Hash de Transacción: ${result.result.hash}`);
        return {
          success: true,
          hash: result.result.hash,
          sequence: result.result.Sequence,
          result: result
        };
      } else {
        console.error(`Error en la transacción ${txJSON.TransactionType}: ${txResult}`);
        return { success: false, error: txResult, result: result };
      }
    } catch (error) {
      console.error(`Excepción al enviar transacción ${txJSON.TransactionType}:`, error);
      throw error;
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
}
