import { Client, LedgerCloseStream } from 'xrpl';

export class XRPLWebsocketReader {
  private client: Client;

  constructor(wsUrl: string) {
    this.client = new Client(wsUrl);
  }

  /**
   * Conecta al cliente WebSocket de XRPL y activa las suscripciones.
   */
  async start() {
    console.log(`Conectando al nodo XRPL WebSocket en: ${this.client.connection.getUrl()}...`);
    await this.client.connect();
    console.log('Conexión WebSocket establecida exitosamente.');

    // 1. Suscribirse a los eventos del Ledger (cierres de bloques)
    await this.subscribeToLedgers();

    // 2. Suscribirse a un libro de órdenes de ejemplo (XRP/USD en Testnet)
    // Usaremos un emisor de USD de prueba muy común en Testnet o un par de prueba.
    await this.subscribeToOrderBook();
  }

  /**
   * Se suscribe al stream de cierre de ledgers
   */
  private async subscribeToLedgers() {
    this.client.connection.on('ledgerClosed', (ledger: LedgerCloseStream) => {
      console.log(`\n==================================================`);
      console.log(`[Ledger #${ledger.ledger_index}] CERRADO`);
      console.log(`Hash: ${ledger.ledger_hash}`);
      console.log(`Transacciones validadas en este bloque: ${ledger.txn_count}`);
      console.log(`==================================================`);
    });

    try {
      const response = await this.client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
      console.log('Suscripción a eventos de Ledger: OK', response.result ? 'Completado' : '');
    } catch (error) {
      console.error('Error al suscribirse al stream de ledgers:', error);
    }
  }

  /**
   * Se suscribe a un libro de órdenes (DEX) específico.
   * Monitorearemos ofertas entre XRP y un USD sintético de pruebas.
   */
  private async subscribeToOrderBook() {
    // Parámetros del libro de órdenes:
    // TakerPays: Lo que el comprador quiere adquirir.
    // TakerGets: Lo que el comprador ofrece.
    const takerPays = { currency: 'XRP' };
    const takerGets = {
      currency: 'USD',
      issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' // Bitstamp USD issuer (dirección clásica válida)
    };

    try {
      // Registrar eventos para el libro de órdenes
      // El evento 'transaction' se dispara cuando hay transacciones asociadas a nuestras suscripciones
      this.client.connection.on('transaction', (tx) => {
        if (tx.transaction.TransactionType === 'OfferCreate') {
          console.log(`\n[NUEVA OFERTA DEX]`);
          console.log(`Cuenta: ${tx.transaction.Account}`);
          console.log(`Paga (TakerPays): ${JSON.stringify(tx.transaction.TakerPays)}`);
          console.log(`Recibe (TakerGets): ${JSON.stringify(tx.transaction.TakerGets)}`);
        }
      });

      // Solicitar la suscripción al libro de órdenes
      const response = await this.client.request({
        command: 'subscribe',
        books: [
          {
            taker_pays: takerPays,
            taker_gets: takerGets,
            snapshot: true, // Recibir estado actual del libro
            both: true,     // Suscribirse a ambas direcciones (compra y venta)
          },
        ],
      });

      console.log('Suscripción al libro de órdenes XRP/USD: OK');
      
      // Mostrar breve snapshot inicial del libro si está disponible
      const bids = (response.result as any).bids || [];
      const asks = (response.result as any).asks || [];
      console.log(`[Snapshot Inicial del Libro] Ofertas de Compra (Bids): ${bids.length}, Ofertas de Venta (Asks): ${asks.length}`);
    } catch (error) {
      console.error('Error al suscribirse al libro de órdenes:', error);
    }
  }

  /**
   * Cierra la conexión de forma limpia.
   */
  async stop() {
    console.log('Desconectando de XRPL...');
    await this.client.disconnect();
    console.log('Desconectado.');
  }
}
