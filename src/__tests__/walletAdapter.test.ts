import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EOAWalletAdapter } from '../walletAdapters/eoaWalletAdapter.js';
import { MockWalletAdapter } from '../walletAdapters/mockWalletAdapter.js';
import { SafeWalletAdapter } from '../walletAdapters/safeWalletAdapter.js';
import { XRPLWalletManager } from '../walletManager.js';
import { Client, Wallet } from 'xrpl';

// Mock de client
const mockGetXrpBalance = vi.fn().mockResolvedValue(100);
const mockRequest = vi.fn().mockResolvedValue({
  result: {
    lines: [
      { currency: 'USD', balance: '123.45', account: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' }
    ]
  }
});
const mockAutofill = vi.fn().mockImplementation(tx => Promise.resolve(tx));
const mockSubmit = vi.fn().mockResolvedValue({
  result: {
    engine_result: 'tesSUCCESS'
  }
});

const mockClient = {
  getXrpBalance: mockGetXrpBalance,
  request: mockRequest,
  autofill: mockAutofill,
  submit: mockSubmit,
  connection: {
    getUrl: () => 'wss://s.altnet.rippletest.net:51233'
  }
} as unknown as Client;

describe('Wallet Adapter Pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('EOAWalletAdapter', () => {
    it('debe inicializarse correctamente con una semilla de billetera', async () => {
      const seed = 'sEdV3qkRMjNjbEHRdS7vUoWw3hA6mZ9'; // testnet seed válida
      const adapter = new EOAWalletAdapter(mockClient, seed);
      
      await adapter.initialize();
      expect(adapter.isConfigured()).toBe(true);
      expect(await adapter.getAddress()).toBeDefined();
      expect(adapter.getUnderlyingWallet()).not.toBeNull();
    });

    it('debe obtener balances de XRP e IOU tokens usando el cliente', async () => {
      const seed = 'sEdV3qkRMjNjbEHRdS7vUoWw3hA6mZ9';
      const adapter = new EOAWalletAdapter(mockClient, seed);
      await adapter.initialize();

      const bal = await adapter.getBalances();
      expect(bal.xrp).toBe(100);
      expect(bal.usd).toBe(123.45);
      expect(mockGetXrpBalance).toHaveBeenCalledTimes(1);
    });

    it('debe firmar y ejecutar transacciones localmente con exito', async () => {
      const seed = 'sEdV3qkRMjNjbEHRdS7vUoWw3hA6mZ9';
      const adapter = new EOAWalletAdapter(mockClient, seed);
      await adapter.initialize();

      const tx = { TransactionType: 'Payment', Account: 'rAddress', Destination: 'rDest', Amount: '1000' } as any;
      const res = await adapter.signAndExecute(tx);

      expect(res.success).toBe(true);
      expect(res.txHash).toBeDefined();
      expect(mockSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('MockWalletAdapter', () => {
    it('debe proveer datos simulados consistentes sin llamadas RPC', async () => {
      const adapter = new MockWalletAdapter();
      await adapter.initialize();

      expect(adapter.isConfigured()).toBe(true);
      expect(await adapter.getAddress()).toContain('rMOCKWALLET');
      
      const bal = await adapter.getBalances();
      expect(bal.xrp).toBe(1000);
      expect(bal.usd).toBe(500);
    });

    it('debe actualizar los balances simulados al ejecutar transacciones', async () => {
      const adapter = new MockWalletAdapter();
      await adapter.initialize();

      const tx = {
        TransactionType: 'Payment',
        Amount: '10000000' // 10 XRP en drops
      } as any;

      const res = await adapter.signAndExecute(tx);
      expect(res.success).toBe(true);
      
      const bal = await adapter.getBalances();
      expect(bal.xrp).toBe(990); // 1000 - 10
    });
  });

  describe('SafeWalletAdapter', () => {
    it('debe inicializarse como un borrador de cuenta inteligente', async () => {
      const adapter = new SafeWalletAdapter();
      await adapter.initialize();

      expect(adapter.isConfigured()).toBe(true);
      expect(await adapter.getAddress()).toBeDefined();
      
      const res = await adapter.signAndExecute({} as any);
      expect(res.success).toBe(true);
      expect(res.txHash).toContain('0xSafeTxHash_');
    });
  });

  describe('XRPLWalletManager Integration', () => {
    it('debe delegar consultas y carga al adaptador inyectado', async () => {
      const mockAdapter = new MockWalletAdapter();
      const manager = new XRPLWalletManager(mockClient, mockAdapter);

      await manager.initializeWallet(null);
      
      const xrpStr = await manager.getXrpBalance();
      expect(xrpStr).toBe('1000');

      const address = await manager.getActiveAdapter().getAddress();
      expect(address).toContain('rMOCKWALLET');
    });
  });
});
