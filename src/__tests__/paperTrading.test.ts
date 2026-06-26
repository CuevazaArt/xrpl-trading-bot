import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import { Wallet } from 'xrpl';
import { PaperOrderManager } from '../paperTrading.js';

// Mock filesystem to avoid polluting real files
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  }
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
}));

describe('Paper Trading System', () => {
  let manager: PaperOrderManager;
  const mockWallet = {
    address: 'rTestAddress123456789',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new PaperOrderManager({} as any, 1000, 'TestStrategy');
    manager.setOraclePrice(0.50); // Set XRP to $0.50
  });

  describe('Initialization', () => {
    it('debe iniciar con balance USDT inicial y XRP en cero', () => {
      const db = manager.getDB();
      const portfolio = db.getPortfolio();
      expect(portfolio.usdt).toBe(1000);
      expect(portfolio.xrp).toBe(0);
      expect(portfolio.totalValueUsdt).toBe(1000);
      expect(portfolio.pnlUsdt).toBe(0);
      expect(portfolio.pnlPct).toBe(0);
    });
  });

  describe('Trades & Order interception', () => {
    it('debe ejecutar BUY orden de mercado correctamente si hay saldo', async () => {
      // Comprar 100 XRP a $0.50 = Costo $50 USDT. Fee estimado 0.01% = $0.005 USDT.
      // En parseOrder: takerPays es drops (drops = qty * 1M). 100 XRP = 100,000,000 drops.
      // takerGets es USDT object { currency: 'USD', value: '50.0' }
      const result = await manager.createMarketOrder(
        mockWallet,
        '100000000', // 100 XRP drops
        { currency: 'USD', value: '50.0' } as any
      );

      expect(result.success).toBe(true);
      expect(result.hash).toContain('PAPER_');

      const portfolio = manager.getDB().getPortfolio();
      expect(portfolio.xrp).toBe(100);
      // Saldo usdt inicial = 1000. Descontamos 50 (cost) y 0.005 (fee).
      expect(portfolio.usdt).toBeCloseTo(949.995);
    });

    it('debe rechazar orden de compra si excede saldo usdt', async () => {
      // Intentar comprar 3000 XRP a $0.50 = $1500 USD (saldo es $1000)
      const result = await manager.createMarketOrder(
        mockWallet,
        '3000000000', // 3000 XRP
        { currency: 'USD', value: '1500.0' } as any
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Paper: fondos insuficientes');

      const portfolio = manager.getDB().getPortfolio();
      expect(portfolio.xrp).toBe(0);
      expect(portfolio.usdt).toBe(1000);
    });

    it('debe ejecutar SELL orden de mercado correctamente si hay XRP suficiente', async () => {
      // 1. Primero compramos 100 XRP
      await manager.createMarketOrder(mockWallet, '100000000', { currency: 'USD', value: '50.0' } as any);

      // 2. Ahora vendemos 50 XRP a $0.50. TakerGets es string (drops) para vender XRP.
      // takerPays es USDT object.
      const result = await manager.createMarketOrder(
        mockWallet,
        { currency: 'USD', value: '25.0' } as any,
        '50000000' // 50 XRP drops
      );

      expect(result.success).toBe(true);
      const portfolio = manager.getDB().getPortfolio();
      expect(portfolio.xrp).toBe(50);
    });

    it('debe rechazar orden de venta si no hay XRP suficiente', async () => {
      const result = await manager.createMarketOrder(
        mockWallet,
        { currency: 'USD', value: '50.0' } as any,
        '100000000' // 100 XRP drops (saldo es 0)
      );

      expect(result.success).toBe(false);
      const portfolio = manager.getDB().getPortfolio();
      expect(portfolio.xrp).toBe(0);
    });
  });

  describe('Snapshots and Metrics', () => {
    it('debe actualizar el total de portfolio y calcular métricas correctas', async () => {
      const db = manager.getDB();
      
      // Comprar 200 XRP a $0.50 (costo: $100 USDT, fee: 0.01% = $0.01)
      await manager.createMarketOrder(mockWallet, '200000000', { currency: 'USD', value: '100.0' } as any);

      // Cambiar precio de XRP a $0.60
      manager.setOraclePrice(0.60);
      db.updatePortfolioValue(0.60);

      const portfolio = db.getPortfolio();
      // USDT restante: 1000 - 100.01 = 899.99
      // Valor XRP: 200 * 0.60 = 120.00
      // Total value: 899.99 + 120.00 = 1019.99
      expect(portfolio.totalValueUsdt).toBeCloseTo(1019.99);
      expect(portfolio.pnlUsdt).toBeCloseTo(19.99);
      expect(portfolio.pnlPct).toBeCloseTo(1.999);
    });
  });
});
