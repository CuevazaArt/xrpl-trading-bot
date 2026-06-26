import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock de fetch global
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Importar después del mock
const { MultiOracle } = await import('../multiOracle.js');

// =====================================================================
// HELPERS
// =====================================================================

function mockCoinbaseResponse(price: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { amount: price.toString() } }),
  };
}

function mockBinanceResponse(price: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ price: price.toString() }),
  };
}

function mockKrakenResponse(price: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: { XXRPZUSD: { c: [price.toString(), '100'] } },
    }),
  };
}

function mockCryptoCompareResponse(price: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ USD: price }),
  };
}

function mockAllSources(price: number, variation: number = 0) {
  fetchMock
    .mockResolvedValueOnce(mockCoinbaseResponse(price + variation))
    .mockResolvedValueOnce(mockBinanceResponse(price))
    .mockResolvedValueOnce(mockKrakenResponse(price - variation))
    .mockResolvedValueOnce(mockCryptoCompareResponse(price + variation * 0.5));
}

// =====================================================================
// TESTS
// =====================================================================

describe('MultiOracle', () => {
  let oracle: InstanceType<typeof MultiOracle>;

  beforeEach(() => {
    fetchMock.mockReset();
    oracle = new MultiOracle({ cacheTtlMs: 0 }); // Sin caché para tests
  });

  describe('Consenso con todas las fuentes', () => {
    it('debe retornar precio de consenso cuando todas las fuentes concuerdan', async () => {
      mockAllSources(2.50);

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBeCloseTo(2.50, 1);
      expect(result!.confidence).toBeGreaterThan(0.5);
      expect(result!.sources).toHaveLength(4);
      expect(result!.sources.filter(s => s.healthy)).toHaveLength(4);
    });

    it('debe calcular spread entre fuentes', async () => {
      // Precios: Coinbase=2.52, Binance=2.50, Kraken=2.48, CC=2.51
      mockAllSources(2.50, 0.02);

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      expect(result!.spread).toBeGreaterThan(0);
      expect(result!.spread).toBeLessThan(0.05); // Max 0.04 spread
    });
  });

  describe('Outlier rejection', () => {
    it('debe rechazar una fuente con precio muy diferente (>2%)', async () => {
      // Coinbase reporta precio loco, las otras 3 concuerdan
      fetchMock
        .mockResolvedValueOnce(mockCoinbaseResponse(5.00))  // Outlier!
        .mockResolvedValueOnce(mockBinanceResponse(2.50))
        .mockResolvedValueOnce(mockKrakenResponse(2.49))
        .mockResolvedValueOnce(mockCryptoCompareResponse(2.51));

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      // El precio no debe ser jalado por el outlier de 5.00
      expect(result!.price).toBeCloseTo(2.50, 1);
      expect(result!.price).toBeLessThan(3.0);
    });
  });

  describe('Degradación con fuentes fallidas', () => {
    it('debe funcionar con 2 fuentes válidas (mínimo)', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))  // Coinbase fail
        .mockResolvedValueOnce(mockBinanceResponse(2.50))   // OK
        .mockRejectedValueOnce(new Error('Timeout'))        // Kraken fail
        .mockResolvedValueOnce(mockCryptoCompareResponse(2.51)); // OK

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBeCloseTo(2.50, 1);
    });

    it('debe retornar null con solo 1 fuente válida', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(mockBinanceResponse(2.50))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));

      const result = await oracle.getConsensusPrice();

      // Solo 1 fuente válida < minSources (2)
      expect(result).toBeNull();
    });

    it('debe retornar null cuando todas las fuentes fallan', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));

      const result = await oracle.getConsensusPrice();

      expect(result).toBeNull();
    });
  });

  describe('Confidence scoring', () => {
    it('debe tener alta confianza cuando 4 fuentes concuerdan', async () => {
      mockAllSources(2.50, 0.001); // Variación mínima

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThan(0.7);
    });

    it('debe tener baja confianza con spread alto entre fuentes', async () => {
      // Gran diferencia entre fuentes (pero dentro del 2% de outlier)
      fetchMock
        .mockResolvedValueOnce(mockCoinbaseResponse(2.53))
        .mockResolvedValueOnce(mockBinanceResponse(2.50))
        .mockResolvedValueOnce(mockKrakenResponse(2.47))
        .mockResolvedValueOnce(mockCryptoCompareResponse(2.52));

      const result = await oracle.getConsensusPrice();

      expect(result).not.toBeNull();
      // Spread es ~2.4% del mid, así que confidence should be lower
      expect(result!.confidence).toBeLessThan(0.9);
    });
  });

  describe('Source health tracking', () => {
    it('debe reportar estado de salud por fuente', async () => {
      mockAllSources(2.50);
      await oracle.getConsensusPrice();

      const health = oracle.getSourceHealth();

      expect(health.Coinbase.healthy).toBe(true);
      expect(health.Binance.healthy).toBe(true);
      expect(health.Kraken.healthy).toBe(true);
      expect(health.CryptoCompare.healthy).toBe(true);
    });

    it('debe marcar fuentes fallidas como unhealthy', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(mockBinanceResponse(2.50))
        .mockResolvedValueOnce(mockKrakenResponse(2.50))
        .mockResolvedValueOnce(mockCryptoCompareResponse(2.50));

      await oracle.getConsensusPrice();

      const health = oracle.getSourceHealth();
      expect(health.Coinbase.failures).toBe(1);
      expect(health.Binance.healthy).toBe(true);
    });
  });

  describe('Caché', () => {
    it('debe retornar precio cacheado dentro del TTL', async () => {
      const cachedOracle = new MultiOracle({ cacheTtlMs: 5000 });

      mockAllSources(2.50);
      const first = await cachedOracle.getConsensusPrice();

      // Segunda llamada — no debe hacer fetch
      const second = await cachedOracle.getConsensusPrice();

      expect(first!.price).toBe(second!.price);
      expect(fetchMock).toHaveBeenCalledTimes(4); // Solo el primer batch
    });
  });
});
