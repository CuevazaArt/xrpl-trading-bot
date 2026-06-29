import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStrategy } from '../strategies/index.js';
import { XRPLMarketMakerStrategy } from '../strategies/marketMaker.js';
import { XRPLDorothyStrategy } from '../strategies/dorothy.js';
import { XRPLElphabaStrategy } from '../strategies/elphaba.js';
import { XRPLBaseLouiseStrategy } from '../strategies/louise.js';
import { XRPLBaseAntiLouiseStrategy } from '../strategies/anti_louise.js';
import { XRPLMashaStrategy } from '../strategies/masha.js';
import { XRPLThusneldaStrategy } from '../strategies/thusnelda.js';
import { XRPLAgarthaStrategy } from '../strategies/agartha.js';

describe('Factory de Estrategias', () => {
  it('debe instanciar las estrategias correctas en base al nombre', () => {
    const mm = createStrategy('market_maker');
    expect(mm).toBeInstanceOf(XRPLMarketMakerStrategy);
    expect(mm.name).toBe('market_maker');

    const dorothy = createStrategy('dorothy');
    expect(dorothy).toBeInstanceOf(XRPLDorothyStrategy);
    expect(dorothy.name).toBe('dorothy');

    const elphaba = createStrategy('elphaba');
    expect(elphaba).toBeInstanceOf(XRPLElphabaStrategy);
    expect(elphaba.name).toBe('elphaba');

    const louise = createStrategy('louise');
    expect(louise).toBeInstanceOf(XRPLBaseLouiseStrategy);
    expect(louise.name).toBe('louise');

    const antiLouise = createStrategy('anti_louise');
    expect(antiLouise).toBeInstanceOf(XRPLBaseAntiLouiseStrategy);
    expect(antiLouise.name).toBe('anti_louise');

    const masha = createStrategy('masha');
    expect(masha).toBeInstanceOf(XRPLMashaStrategy);
    expect(masha.name).toBe('masha');

    const thusnelda = createStrategy('thusnelda');
    expect(thusnelda).toBeInstanceOf(XRPLThusneldaStrategy);
    expect(thusnelda.name).toBe('thusnelda');

    const agartha = createStrategy('agartha');
    expect(agartha).toBeInstanceOf(XRPLAgarthaStrategy);
    expect(agartha.name).toBe('agartha');
  });

  it('debe cargar market_maker por defecto ante nombres desconocidos', () => {
    const unknown = createStrategy('estrategia_inventada_123');
    expect(unknown).toBeInstanceOf(XRPLMarketMakerStrategy);
    expect(unknown.name).toBe('market_maker');
  });
});

describe('Estrategias de Trading', () => {
  let mockClient: any;
  let mockWallet: any;
  let mockOrderManager: any;
  let mockDashboard: any;

  beforeEach(() => {
    mockClient = {
      request: vi.fn().mockResolvedValue({
        result: { offers: [] }
      }),
      getXrpBalance: vi.fn().mockResolvedValue('100')
    };

    mockWallet = {
      address: 'rTestWalletAddress123456'
    };

    mockOrderManager = {
      createLimitOrder: vi.fn().mockResolvedValue({
        success: true,
        sequence: 123,
        hash: 'TESTHASH'
      }),
      cancelOrder: vi.fn().mockResolvedValue({
        success: true
      })
    };

    mockDashboard = {
      updateState: vi.fn()
    };
  });

  describe('Dorothy DCA Long', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const dorothy = new XRPLDorothyStrategy();
      await dorothy.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Dorothy DCA Long',
          walletAddress: mockWallet.address
        })
      );
    });
  });

  describe('Elphaba DCA Short', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const elphaba = new XRPLElphabaStrategy();
      await elphaba.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Elphaba DCA Short',
          walletAddress: mockWallet.address
        })
      );
    });
  });

  describe('Louise DCA Long', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const louise = new XRPLBaseLouiseStrategy();
      await louise.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Louise DCA Long',
          walletAddress: mockWallet.address
        })
      );
    });
  });

  describe('Anti-Louise DCA Short', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const antiLouise = new XRPLBaseAntiLouiseStrategy();
      await antiLouise.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Anti-Louise DCA Short',
          walletAddress: mockWallet.address
        })
      );
    });
  });

  describe('Masha DCA Accumulator (HODL)', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const masha = new XRPLMashaStrategy();
      await masha.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Masha DCA Accumulator',
          walletAddress: mockWallet.address
        })
      );
    });

    it('debe realizar la compra inicial en el primer tick y guardar estado', async () => {
      const masha = new XRPLMashaStrategy();
      await masha.init(mockClient, mockWallet, mockOrderManager, mockDashboard);
      
      // Limpiar llamadas de mock
      mockOrderManager.createLimitOrder.mockClear();

      // Tick inicial a precio de $1.00 USD
      await masha.tick(100, 1.00);

      // Debe colocar una orden de compra
      expect(mockOrderManager.createLimitOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('Thusnelda Basket DCA', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const thusnelda = new XRPLThusneldaStrategy();
      await thusnelda.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Thusnelda Basket DCA',
          walletAddress: mockWallet.address
        })
      );
    });
  });

  describe('Agartha Moonshot Trailing', () => {
    it('debe inicializarse correctamente y actualizar el dashboard', async () => {
      const agartha = new XRPLAgarthaStrategy();
      await agartha.init(mockClient, mockWallet, mockOrderManager, mockDashboard);

      expect(mockDashboard.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyName: 'Agartha Moonshot Trailing',
          walletAddress: mockWallet.address
        })
      );
    });
  });
});
