import { describe, it, expect, vi, beforeEach } from 'vitest';

// =====================================================================
// Tests para CEXConnector (Binance)
// Verifica: firma HMAC, formateo qty/price, parseo de respuestas,
// modo read-only, y caching de ticker.
// =====================================================================

// Mock de fetch global
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock de config ANTES de importar el módulo
vi.mock('../config.js', () => ({
  config: {
    binanceApiKey: 'test-api-key',
    binanceApiSecret: 'test-api-secret',
    binanceBaseUrl: 'https://api.binance.com',
  },
}));

// Importar después de los mocks
import { CEXConnector } from '../cexConnector.js';

describe('CEXConnector', () => {
  let cex: CEXConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    cex = new CEXConnector();
  });

  describe('isConfigured', () => {
    it('retorna true cuando API keys están configuradas', () => {
      expect(cex.isConfigured()).toBe(true);
    });
  });

  describe('getTicker', () => {
    it('retorna ticker parseado correctamente desde bookTicker', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bidPrice: '2.3456',
          askPrice: '2.3478',
        }),
      });

      const ticker = await cex.getTicker();

      expect(ticker).not.toBeNull();
      expect(ticker!.bidPrice).toBeCloseTo(2.3456, 4);
      expect(ticker!.askPrice).toBeCloseTo(2.3478, 4);
      expect(ticker!.lastPrice).toBeCloseTo((2.3456 + 2.3478) / 2, 4);
      expect(ticker!.timestamp).toBeGreaterThan(0);
    });

    it('retorna caché si se llama dentro del TTL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bidPrice: '2.3456',
          askPrice: '2.3478',
        }),
      });

      const ticker1 = await cex.getTicker();
      const ticker2 = await cex.getTicker();

      // Solo debe haber hecho 1 fetch, el segundo usa caché
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(ticker1).toEqual(ticker2);
    });

    it('retorna caché stale si el fetch falla', async () => {
      // Primer fetch exitoso
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bidPrice: '2.3456',
          askPrice: '2.3478',
        }),
      });

      const ticker1 = await cex.getTicker();

      // Forzar expiración del caché
      (cex as any).lastTickerTime = 0;

      // Segundo fetch falla
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const ticker2 = await cex.getTicker();

      // Debe retornar el caché stale
      expect(ticker2).toEqual(ticker1);
    });

    it('retorna null si no hay caché y el fetch falla', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const ticker = await cex.getTicker();
      expect(ticker).toBeNull();
    });
  });

  describe('Order execution', () => {
    it('marketBuy envía orden MARKET BUY con firma correcta', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 12345,
          status: 'FILLED',
          executedQty: '100.0',
          price: '2.3400',
          fills: [
            { qty: '100.0', price: '2.3400', commission: '0.1', commissionAsset: 'USDT' },
          ],
        }),
      });

      const result = await cex.marketBuy(100);

      expect(result.success).toBe(true);
      expect(result.orderId).toBe('12345');
      expect(result.filledQty).toBe(100);
      expect(result.filledPrice).toBeCloseTo(2.34, 2);
      expect(result.commission).toBe(0.1);
      expect(result.commissionAsset).toBe('USDT');
      expect(result.status).toBe('FILLED');

      // Verificar que se envió con POST y los headers correctos
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('symbol=XRPUSDT');
      expect(url).toContain('side=BUY');
      expect(url).toContain('type=MARKET');
      expect(url).toContain('quantity=100.0');
      expect(url).toContain('signature=');
      expect(options.method).toBe('POST');
      expect(options.headers['X-MBX-APIKEY']).toBe('test-api-key');
    });

    it('marketSell envía orden MARKET SELL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 12346,
          status: 'FILLED',
          executedQty: '50.0',
          fills: [
            { qty: '50.0', price: '2.3500', commission: '0.05', commissionAsset: 'XRP' },
          ],
        }),
      });

      const result = await cex.marketSell(50);

      expect(result.success).toBe(true);
      expect(result.filledQty).toBe(50);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('side=SELL');
      expect(url).toContain('type=MARKET');
    });

    it('limitIOC envía orden LIMIT con timeInForce=IOC', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 12347,
          status: 'FILLED',
          executedQty: '25.0',
          fills: [
            { qty: '25.0', price: '2.3600', commission: '0.025', commissionAsset: 'USDT' },
          ],
        }),
      });

      const result = await cex.limitIOC('BUY', 25, 2.3600);

      expect(result.success).toBe(true);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('type=LIMIT');
      expect(url).toContain('timeInForce=IOC');
      expect(url).toContain('price=2.3600');
      expect(url).toContain('quantity=25.0');
    });

    it('retorna error si Binance rechaza la orden', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          code: -1013,
          msg: 'Filter failure: MIN_NOTIONAL',
        }),
      });

      const result = await cex.marketBuy(0.1);

      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('MIN_NOTIONAL');
    });

    it('retorna error si hay excepción de red', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection timeout'));

      const result = await cex.marketSell(10);

      expect(result.success).toBe(false);
      expect(result.status).toBe('EXCEPTION');
      expect(result.error).toContain('Connection timeout');
    });
  });

  describe('formatQty & formatPrice (via order params)', () => {
    it('formatea cantidad con stepSize=0.1 (redondeo hacia abajo)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 99, status: 'FILLED', executedQty: '0', fills: [],
        }),
      });

      await cex.marketBuy(12.3456789);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('quantity=12.3');
    });

    it('formatea precio con tickSize=0.0001', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 99, status: 'FILLED', executedQty: '0', fills: [],
        }),
      });

      await cex.limitIOC('SELL', 10, 2.34567);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('price=2.3456');
    });
  });

  describe('getBalances', () => {
    it('parsea balances de XRP y USDT correctamente', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [
            { asset: 'BTC', free: '0.001', locked: '0' },
            { asset: 'XRP', free: '500.5', locked: '100' },
            { asset: 'USDT', free: '1234.56', locked: '0' },
          ],
        }),
      });

      const bal = await cex.getBalances();

      expect(bal.xrp).toBeCloseTo(500.5, 1);
      expect(bal.usd).toBeCloseTo(1234.56, 2);
    });

    it('retorna 0 si el asset no existe', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [
            { asset: 'BTC', free: '0.001', locked: '0' },
          ],
        }),
      });

      const bal = await cex.getBalances();

      expect(bal.xrp).toBe(0);
      expect(bal.usd).toBe(0);
    });
  });

  describe('HMAC Signature', () => {
    it('incluye signature en todas las órdenes autenticadas', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orderId: 1, status: 'FILLED', executedQty: '0', fills: [],
        }),
      });

      await cex.marketBuy(10);

      const [url] = mockFetch.mock.calls[0];
      // Signature debe ser hex de 64 caracteres (SHA256)
      const sigMatch = url.match(/signature=([a-f0-9]+)/);
      expect(sigMatch).not.toBeNull();
      expect(sigMatch[1].length).toBe(64);
    });
  });
});
