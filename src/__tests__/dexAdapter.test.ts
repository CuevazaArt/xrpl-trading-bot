import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDexAdapter } from '../dexAdapters/mockAdapter.js';
import { QuoteRequest } from '../dexAdapters/IDEXAdapter.js';

describe('DEX Adapter Pattern', () => {
  let adapter: MockDexAdapter;

  beforeEach(() => {
    adapter = new MockDexAdapter();
  });

  it('debe inicializarse correctamente', async () => {
    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it('debe rechazar cotizaciones si no está inicializado', async () => {
    const req: QuoteRequest = {
      fromToken: { currency: 'XRP', value: '0' },
      toToken: { currency: 'USD', value: '0' },
      amount: '10',
      slippagePct: 0.5
    };
    const result = await adapter.getQuote(req);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no inicializado');
  });

  it('debe obtener cotización correctamente tras ser inicializado', async () => {
    await adapter.initialize();
    const req: QuoteRequest = {
      fromToken: { currency: 'XRP', value: '0' },
      toToken: { currency: 'USD', value: '0' },
      amount: '10',
      slippagePct: 1.0
    };
    const result = await adapter.getQuote(req);
    expect(result.success).toBe(true);
    expect(parseFloat(result.outputAmount)).toBe(10.5);
    expect(parseFloat(result.expectedOutput)).toBeCloseTo(10.5 * 0.99, 4);
  });

  it('debe capturar errores de cotización de forma segura sin propagar excepciones', async () => {
    await adapter.initialize();
    const req: QuoteRequest = {
      fromToken: { currency: 'XRP', value: '0' },
      toToken: { currency: 'USD', value: '0' },
      amount: '-5', // Cantidad inválida que lanza error
      slippagePct: 1.0
    };
    const result = await adapter.getQuote(req);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('debe ejecutar un swap de forma segura', async () => {
    await adapter.initialize();
    const quote = {
      success: true,
      inputAmount: '10',
      outputAmount: '10.5',
      priceImpactPct: 0.05,
      expectedOutput: '10.395',
      executionRoute: {}
    };

    const wallet = { address: 'rMockAddress' };
    const result = await adapter.executeSwap(wallet, quote);
    expect(result.success).toBe(true);
    expect(result.txHash).toContain('MOCK_TX_');
    expect(result.feePaid).toBe('12');
  });

  it('debe capturar excepciones fatales de ejecución de forma segura', async () => {
    await adapter.initialize();
    const quote = {
      success: true,
      inputAmount: '10',
      outputAmount: '10.5',
      priceImpactPct: 0.05,
      expectedOutput: '10.395',
      executionRoute: {}
    };

    // Pasar null wallet causará excepción en performExecuteSwap
    const result = await adapter.executeSwap(null, quote);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
