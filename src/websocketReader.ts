import { Client } from 'xrpl';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('WebSocketReader');

/**
 * Eventos tipados que emite el reader:
 * - 'ledgerClosed': { ledger_index, ledger_hash, txn_count }
 * - 'orderBookUpdate': { account, takerPays, takerGets }
 * - 'ownTransaction': { hash, type, meta } — transacciones de nuestra cuenta
 */
export interface LedgerEvent {
  ledger_index: number;
  ledger_hash: string;
  txn_count: number;
}

export interface OrderBookEvent {
  account: string;
  takerPays: any;
  takerGets: any;
}

export class XRPLWebsocketReader extends EventEmitter {
  private client: Client;
  private walletAddress: string | null = null;

  /**
   * Recibe el Client compartido (no crea conexión propia).
   */
  constructor(client: Client) {
    super();
    this.client = client;
  }

  /**
   * Establece la dirección de la wallet para detectar transacciones propias.
   */
  setWalletAddress(address: string) {
    this.walletAddress = address;
  }

  /**
   * Activa las suscripciones sobre el Client compartido ya conectado.
   */
  async start() {
    log.info('Activando suscripciones WebSocket...');

    // 1. Suscribirse a los eventos del Ledger (cierres de bloques)
    await this.subscribeToLedgers();

    // 2. Suscribirse a un libro de órdenes (XRP/USD)
    await this.subscribeToOrderBook();

    // 3. Suscribirse a transacciones de nuestra cuenta
    if (this.walletAddress) {
      await this.subscribeToOwnAccount();
    }
  }

  /**
   * Se suscribe al stream de cierre de ledgers
   */
  private async subscribeToLedgers() {
    this.client.connection.on('ledgerClosed', (ledger: any) => {
      const event: LedgerEvent = {
        ledger_index: ledger.ledger_index,
        ledger_hash: ledger.ledger_hash,
        txn_count: ledger.txn_count,
      };
      log.debug(`Ledger #${event.ledger_index} cerrado (${event.txn_count} txs)`);
      this.emit('ledgerClosed', event);
    });

    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
      log.info('Suscripción a eventos de Ledger: OK');
    } catch (error) {
      log.error('Error al suscribirse al stream de ledgers:', error);
    }
  }

  /**
   * Se suscribe al libro de órdenes XRP/USD (Bitstamp).
   */
  private async subscribeToOrderBook() {
    const usdIssuer = config.usdIssuer;

    try {
      this.client.connection.on('transaction', (tx) => {
        if (tx.transaction.TransactionType === 'OfferCreate') {
          const event: OrderBookEvent = {
            account: tx.transaction.Account,
            takerPays: tx.transaction.TakerPays,
            takerGets: tx.transaction.TakerGets,
          };
          this.emit('orderBookUpdate', event);
        }
      });

      const response = await this.client.request({
        command: 'subscribe',
        books: [
          {
            taker_pays: { currency: 'XRP' } as any,
            taker_gets: { currency: 'USD', issuer: usdIssuer } as any,
            taker: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
            snapshot: true,
            both: true,
          },
        ],
      } as any);

      const bids = (response.result as any).bids || [];
      const asks = (response.result as any).asks || [];
      log.info(`Suscripción al libro XRP/USD: OK (Bids: ${bids.length}, Asks: ${asks.length})`);
    } catch (error) {
      log.error('Error al suscribirse al libro de órdenes:', error);
    }
  }

  /**
   * Se suscribe a las transacciones de nuestra propia cuenta
   * para detectar fills de órdenes.
   */
  private async subscribeToOwnAccount() {
    try {
      await this.client.request({
        command: 'subscribe',
        accounts: [this.walletAddress!],
      });
      log.info(`Suscripción a transacciones de cuenta ${this.walletAddress}: OK`);
    } catch (error) {
      log.error('Error al suscribirse a transacciones de cuenta:', error);
    }
  }
}
