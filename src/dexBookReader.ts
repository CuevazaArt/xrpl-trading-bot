import { Client } from 'xrpl';
import { createLogger } from './logger.js';

const log = createLogger('DEXBookReader');

// =====================================================================
// TIPOS PÚBLICOS
// =====================================================================

export interface DEXOrderLevel {
  price: number;      // Precio en USD por 1 XRP
  volumeXrp: number;  // Volumen disponible en XRP
  volumeUsd: number;  // Volumen disponible en USD
}

export interface DEXBookSnapshot {
  bestBid: number;            // Mejor precio de compra (alguien compra XRP a este precio)
  bestAsk: number;            // Mejor precio de venta (alguien vende XRP a este precio)
  midPrice: number;           // (bestBid + bestAsk) / 2
  bidDepth: number;           // XRP total disponible en bids (top N niveles)
  askDepth: number;           // XRP total disponible en asks (top N niveles)
  spreadPct: number;          // Spread como % del mid price
  bidLevels: DEXOrderLevel[]; // Niveles de bid (mejores primero)
  askLevels: DEXOrderLevel[]; // Niveles de ask (mejores primero)
  timestamp: number;
}

// =====================================================================
// DEX BOOK READER
// =====================================================================

/**
 * Lee el order book real del DEX XRPL para el par XRP/USD (Bitstamp IOU).
 * 
 * Conceptos clave de XRPL order book:
 * - `book_offers` retorna las ofertas desde la perspectiva del "taker"
 * - Para ver quién VENDE XRP por USD: TakerPays=USD, TakerGets=XRP (asks)
 * - Para ver quién COMPRA XRP con USD: TakerPays=XRP, TakerGets=USD (bids)
 * - Los precios se invierten según el lado del book
 */
export class DEXBookReader {
  private client: Client;
  private readonly usdIssuer: string;
  private readonly depthLevels: number;
  private readonly cacheTtlMs: number;

  private cachedSnapshot: DEXBookSnapshot | null = null;
  private lastFetchTime: number = 0;

  constructor(client: Client, options?: {
    usdIssuer?: string;
    depthLevels?: number;
    cacheTtlMs?: number;
  }) {
    this.client = client;
    this.usdIssuer = options?.usdIssuer ?? 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
    this.depthLevels = options?.depthLevels ?? 10;
    this.cacheTtlMs = options?.cacheTtlMs ?? 3000;
  }

  /**
   * Obtiene un snapshot del order book XRP/USD del DEX.
   * Retorna null si el book está vacío o inaccesible.
   */
  async getBookSnapshot(): Promise<DEXBookSnapshot | null> {
    const now = Date.now();

    // Caché
    if (this.cachedSnapshot && (now - this.lastFetchTime) < this.cacheTtlMs) {
      return this.cachedSnapshot;
    }

    try {
      // Fetch ambos lados del book en paralelo
      const [askOffers, bidOffers] = await Promise.all([
        this.fetchAsks(),
        this.fetchBids(),
      ]);

      if (askOffers.length === 0 && bidOffers.length === 0) {
        log.warn('DEX order book vacío para XRP/USD.');
        return null;
      }

      // Construir snapshot
      const bestBid = bidOffers.length > 0 ? bidOffers[0].price : 0;
      const bestAsk = askOffers.length > 0 ? askOffers[0].price : 0;

      // Validar que bid < ask (book no cruzado)
      if (bestBid > 0 && bestAsk > 0 && bestBid >= bestAsk) {
        log.warn(`Book cruzado detectado: Bid(${bestBid.toFixed(6)}) >= Ask(${bestAsk.toFixed(6)}). Posible oportunidad de arb inmediata o datos inconsistentes.`);
      }

      const midPrice = (bestBid > 0 && bestAsk > 0)
        ? (bestBid + bestAsk) / 2
        : bestBid > 0 ? bestBid : bestAsk;

      const spreadPct = (bestBid > 0 && bestAsk > 0)
        ? ((bestAsk - bestBid) / midPrice) * 100
        : 100; // Book de un solo lado = spread infinito

      const bidDepth = bidOffers.reduce((sum, o) => sum + o.volumeXrp, 0);
      const askDepth = askOffers.reduce((sum, o) => sum + o.volumeXrp, 0);

      const snapshot: DEXBookSnapshot = {
        bestBid,
        bestAsk,
        midPrice,
        bidDepth,
        askDepth,
        spreadPct,
        bidLevels: bidOffers,
        askLevels: askOffers,
        timestamp: now,
      };

      this.cachedSnapshot = snapshot;
      this.lastFetchTime = now;

      log.debug(`DEX Book: Bid=${bestBid.toFixed(6)} | Ask=${bestAsk.toFixed(6)} | Mid=${midPrice.toFixed(6)} | Spread=${spreadPct.toFixed(3)}% | BidDepth=${bidDepth.toFixed(0)}XRP | AskDepth=${askDepth.toFixed(0)}XRP`);

      return snapshot;
    } catch (error) {
      log.error('Error al leer order book del DEX:', error);

      // Retornar caché degradado si existe
      if (this.cachedSnapshot && (now - this.lastFetchTime) < 30000) {
        return this.cachedSnapshot;
      }
      return null;
    }
  }

  // =====================================================================
  // FETCH DEL ORDER BOOK
  // =====================================================================

  /**
   * Asks: personas que VENDEN XRP por USD.
   * En XRPL: TakerPays = XRP (drops), TakerGets = USD IOU
   * → El taker quiere COMPRAR XRP y pagar con USD
   * → Las ofertas existentes son de vendedores de XRP
   * 
   * Precio = USD ofrecido / XRP pedido (cuántos USD por 1 XRP)
   */
  private async fetchAsks(): Promise<DEXOrderLevel[]> {
    try {
      const response = await this.client.request({
        command: 'book_offers',
        taker_pays: { currency: 'XRP' },
        taker_gets: {
          currency: 'USD',
          issuer: this.usdIssuer,
        },
        limit: this.depthLevels,
      });

      const offers = response.result.offers || [];
      return offers.map((offer: any) => {
        const xrpDrops = typeof offer.TakerPays === 'string'
          ? parseFloat(offer.TakerPays)
          : 0;
        const usdValue = typeof offer.TakerGets === 'object'
          ? parseFloat(offer.TakerGets.value)
          : 0;

        const volumeXrp = xrpDrops / 1_000_000;
        const price = volumeXrp > 0 ? usdValue / volumeXrp : 0;

        return { price, volumeXrp, volumeUsd: usdValue };
      }).filter((o: DEXOrderLevel) => o.price > 0 && o.volumeXrp > 0)
        .sort((a: DEXOrderLevel, b: DEXOrderLevel) => a.price - b.price); // Asks: menor primero
    } catch (error) {
      log.error('Error al obtener asks del DEX:', error);
      return [];
    }
  }

  /**
   * Bids: personas que COMPRAN XRP con USD.
   * En XRPL: TakerPays = USD IOU, TakerGets = XRP (drops)
   * → El taker quiere VENDER XRP y recibir USD
   * → Las ofertas existentes son de compradores de XRP
   * 
   * Precio = USD ofrecido / XRP pedido
   */
  private async fetchBids(): Promise<DEXOrderLevel[]> {
    try {
      const response = await this.client.request({
        command: 'book_offers',
        taker_pays: {
          currency: 'USD',
          issuer: this.usdIssuer,
        },
        taker_gets: { currency: 'XRP' },
        limit: this.depthLevels,
      });

      const offers = response.result.offers || [];
      return offers.map((offer: any) => {
        const usdValue = typeof offer.TakerPays === 'object'
          ? parseFloat(offer.TakerPays.value)
          : 0;
        const xrpDrops = typeof offer.TakerGets === 'string'
          ? parseFloat(offer.TakerGets)
          : 0;

        const volumeXrp = xrpDrops / 1_000_000;
        const price = volumeXrp > 0 ? usdValue / volumeXrp : 0;

        return { price, volumeXrp, volumeUsd: usdValue };
      }).filter((o: DEXOrderLevel) => o.price > 0 && o.volumeXrp > 0)
        .sort((a: DEXOrderLevel, b: DEXOrderLevel) => b.price - a.price); // Bids: mayor primero
    } catch (error) {
      log.error('Error al obtener bids del DEX:', error);
      return [];
    }
  }

  /**
   * Calcula cuánto XRP se puede comprar/vender a un precio dado,
   * considerando la profundidad real del book.
   * 
   * Útil para estimar slippage antes de ejecutar.
   */
  getExecutableVolume(side: 'buy' | 'sell', maxPriceImpactPct: number): { volumeXrp: number; avgPrice: number } {
    if (!this.cachedSnapshot) return { volumeXrp: 0, avgPrice: 0 };

    const levels = side === 'buy' ? this.cachedSnapshot.askLevels : this.cachedSnapshot.bidLevels;
    const refPrice = side === 'buy' ? this.cachedSnapshot.bestAsk : this.cachedSnapshot.bestBid;

    if (refPrice <= 0 || levels.length === 0) return { volumeXrp: 0, avgPrice: 0 };

    const maxPrice = side === 'buy'
      ? refPrice * (1 + maxPriceImpactPct / 100)
      : refPrice * (1 - maxPriceImpactPct / 100);

    let totalXrp = 0;
    let totalUsd = 0;

    for (const level of levels) {
      const withinLimit = side === 'buy'
        ? level.price <= maxPrice
        : level.price >= maxPrice;

      if (!withinLimit) break;

      totalXrp += level.volumeXrp;
      totalUsd += level.volumeUsd;
    }

    const avgPrice = totalXrp > 0 ? totalUsd / totalXrp : 0;
    return { volumeXrp: totalXrp, avgPrice };
  }
}
