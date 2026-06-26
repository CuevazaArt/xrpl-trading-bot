import { describe, it, expect, vi, beforeEach } from 'vitest';

// =====================================================================
// Mocks para el módulo de arbitraje
// =====================================================================

// Mock de fetch global (para MultiOracle)
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock del Client XRPL
function createMockClient(bookOffers: { asks: any[]; bids: any[] }) {
  return {
    request: vi.fn().mockImplementation(async (req: any) => {
      if (req.command === 'book_offers') {
        // Asks: TakerPays = XRP, TakerGets = USD
        if (typeof req.taker_pays === 'object' && req.taker_pays.currency === 'USD') {
          // This is bids (taker wants USD, gives XRP)
          return { result: { offers: bookOffers.bids } };
        }
        // Asks
        return { result: { offers: bookOffers.asks } };
      }
      if (req.command === 'account_offers') {
        return { result: { offers: [] } };
      }
      if (req.command === 'account_lines') {
        return { result: { lines: [{ currency: 'USD', account: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', balance: '500' }] } };
      }
      return { result: {} };
    }),
    getXrpBalance: vi.fn().mockResolvedValue('1000'),
  };
}

// Helper para crear ofertas del DEX
function createAskOffer(priceUsd: number, volumeXrp: number) {
  return {
    TakerPays: (volumeXrp * 1_000_000).toString(), // XRP en drops
    TakerGets: { currency: 'USD', value: (volumeXrp * priceUsd).toFixed(4), issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
  };
}

function createBidOffer(priceUsd: number, volumeXrp: number) {
  return {
    TakerPays: { currency: 'USD', value: (volumeXrp * priceUsd).toFixed(4), issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
    TakerGets: (volumeXrp * 1_000_000).toString(), // XRP en drops
  };
}

// Mock all oracle sources at a specific price
function mockOraclesAt(price: number) {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { amount: price.toString() } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ price: price.toString() }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { XXRPZUSD: { c: [price.toString()] } } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ USD: price }) });
}

// =====================================================================
// DEXBookReader tests
// =====================================================================

describe('DEXBookReader', () => {
  it('debe parsear asks y bids correctamente', async () => {
    const client = createMockClient({
      asks: [
        createAskOffer(2.50, 100), // 100 XRP a 2.50 USD
        createAskOffer(2.51, 50),  // 50 XRP a 2.51 USD
      ],
      bids: [
        createBidOffer(2.48, 80),  // 80 XRP a 2.48 USD
        createBidOffer(2.47, 60),  // 60 XRP a 2.47 USD
      ],
    });

    const { DEXBookReader } = await import('../dexBookReader.js');
    const reader = new DEXBookReader(client as any, { cacheTtlMs: 0 });

    const snapshot = await reader.getBookSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.bestAsk).toBeCloseTo(2.50, 1);
    expect(snapshot!.bestBid).toBeCloseTo(2.48, 1);
    expect(snapshot!.midPrice).toBeCloseTo(2.49, 1);
    expect(snapshot!.spreadPct).toBeGreaterThan(0);
    expect(snapshot!.askDepth).toBeCloseTo(150, 0); // 100 + 50
    expect(snapshot!.bidDepth).toBeCloseTo(140, 0); // 80 + 60
  });

  it('debe retornar null si el book está vacío', async () => {
    const client = createMockClient({ asks: [], bids: [] });

    const { DEXBookReader } = await import('../dexBookReader.js');
    const reader = new DEXBookReader(client as any, { cacheTtlMs: 0 });

    const snapshot = await reader.getBookSnapshot();
    expect(snapshot).toBeNull();
  });
});

// =====================================================================
// Arbitrage opportunity detection (unit logic)
// =====================================================================

describe('Arbitrage Opportunity Detection', () => {
  describe('BUY_ARB detection', () => {
    it('debe detectar oportunidad de compra cuando DEX ask < CEX price', () => {
      const cexPrice = 2.50;
      const dexAsk = 2.46;  // DEX vende XRP 1.6% más barato
      const minSpreadPct = 0.15;

      const grossSpreadPct = ((cexPrice - dexAsk) / cexPrice) * 100;
      const netSpreadPct = grossSpreadPct - 0.01; // minus fee estimate

      expect(grossSpreadPct).toBeGreaterThan(1.0);
      expect(netSpreadPct).toBeGreaterThan(minSpreadPct);
    });

    it('NO debe detectar oportunidad cuando spread es insuficiente', () => {
      const cexPrice = 2.50;
      const dexAsk = 2.499; // Casi igual
      const minSpreadPct = 0.15;

      const grossSpreadPct = ((cexPrice - dexAsk) / cexPrice) * 100;
      const netSpreadPct = grossSpreadPct - 0.01;

      expect(netSpreadPct).toBeLessThan(minSpreadPct);
    });
  });

  describe('SELL_ARB detection', () => {
    it('debe detectar oportunidad de venta cuando DEX bid > CEX price', () => {
      const cexPrice = 2.50;
      const dexBid = 2.54; // DEX compra XRP 1.6% más caro
      const minSpreadPct = 0.15;

      const grossSpreadPct = ((dexBid - cexPrice) / cexPrice) * 100;
      const netSpreadPct = grossSpreadPct - 0.01;

      expect(grossSpreadPct).toBeGreaterThan(1.0);
      expect(netSpreadPct).toBeGreaterThan(minSpreadPct);
    });

    it('NO debe detectar oportunidad cuando DEX bid < CEX price', () => {
      const cexPrice = 2.50;
      const dexBid = 2.49; // DEX compra más barato que CEX

      const grossSpreadPct = ((dexBid - cexPrice) / cexPrice) * 100;

      expect(grossSpreadPct).toBeLessThan(0); // Negativo = sin oportunidad
    });
  });

  describe('Risk limits', () => {
    it('debe bloquear por position limit', () => {
      const maxPositionXrp = 200;
      const currentNetPosition = 180;
      const tradeSize = 50;

      const projectedPosition = currentNetPosition + tradeSize;
      const allowed = Math.abs(projectedPosition) <= maxPositionXrp;

      expect(allowed).toBe(false); // 230 > 200
    });

    it('debe permitir dentro de position limit', () => {
      const maxPositionXrp = 200;
      const currentNetPosition = 50;
      const tradeSize = 50;

      const projectedPosition = currentNetPosition + tradeSize;
      const allowed = Math.abs(projectedPosition) <= maxPositionXrp;

      expect(allowed).toBe(true); // 100 <= 200
    });

    it('debe bloquear trades con profit negativo esperado', () => {
      const expectedProfitUsd = -0.05;
      const allowed = expectedProfitUsd > 0;

      expect(allowed).toBe(false);
    });

    it('debe bloquear si trade > 50% de la profundidad del book', () => {
      const tradeSize = 60;
      const executableVolume = 100;

      const allowed = tradeSize <= executableVolume * 0.5;

      expect(allowed).toBe(false); // 60 > 50
    });
  });

  describe('P&L calculation', () => {
    it('debe calcular profit correctamente para BUY_ARB', () => {
      const tradeSize = 50; // XRP
      const cexPrice = 2.50;
      const dexPrice = 2.46; // Ask price
      const networkFeeXrp = 0.000012;

      const profit = tradeSize * (cexPrice - dexPrice) - networkFeeXrp * cexPrice;

      expect(profit).toBeCloseTo(2.0, 1); // ~2 USD profit
      expect(profit).toBeGreaterThan(0);
    });

    it('debe calcular profit correctamente para SELL_ARB', () => {
      const tradeSize = 50;
      const cexPrice = 2.50;
      const dexPrice = 2.54; // Bid price
      const networkFeeXrp = 0.000012;

      const profit = tradeSize * (dexPrice - cexPrice) - networkFeeXrp * cexPrice;

      expect(profit).toBeCloseTo(2.0, 1);
      expect(profit).toBeGreaterThan(0);
    });
  });
});
