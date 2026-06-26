import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del Client de XRPL
const mockAutofill = vi.fn();
const mockSubmitAndWait = vi.fn();

const mockClient = {
  autofill: mockAutofill,
  submitAndWait: mockSubmitAndWait,
} as any;

// Importar el módulo bajo prueba
import { XRPLOrderManager } from '../orderManager.js';

describe('XRPLOrderManager', () => {
  let orderManager: XRPLOrderManager;

  const mockWallet = {
    address: 'rTestAddress123456789',
    sign: vi.fn().mockReturnValue({ tx_blob: 'signed_blob_hex' }),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    orderManager = new XRPLOrderManager(mockClient);

    // Configurar mocks por defecto para transacciones exitosas
    mockAutofill.mockResolvedValue({
      TransactionType: 'OfferCreate',
      Account: mockWallet.address,
    });
    mockSubmitAndWait.mockResolvedValue({
      result: {
        hash: 'ABC123HASH',
        Sequence: 42,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
  });

  describe('createLimitOrder', () => {
    it('debe generar un OfferCreate con TakerPays y TakerGets correctos', async () => {
      const takerPays = '10000000'; // 10 XRP en drops
      const takerGets = { currency: 'USD', value: '5.0000', issuer: 'rIssuer123' };

      await orderManager.createLimitOrder(mockWallet, takerPays, takerGets);

      // Verificar que autofill fue llamado con la transacción correcta
      expect(mockAutofill).toHaveBeenCalledWith({
        TransactionType: 'OfferCreate',
        Account: mockWallet.address,
        TakerPays: takerPays,
        TakerGets: takerGets,
      });
    });

    it('debe firmar y enviar la transacción', async () => {
      await orderManager.createLimitOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(mockWallet.sign).toHaveBeenCalled();
      expect(mockSubmitAndWait).toHaveBeenCalledWith('signed_blob_hex');
    });

    it('debe retornar success=true y hash cuando tesSUCCESS', async () => {
      const result = await orderManager.createLimitOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(result.success).toBe(true);
      expect(result.hash).toBe('ABC123HASH');
      expect(result.sequence).toBe(42);
    });

    it('debe retornar success=false cuando la transacción falla', async () => {
      mockSubmitAndWait.mockResolvedValue({
        result: {
          hash: 'FAIL_HASH',
          Sequence: 43,
          meta: { TransactionResult: 'tecUNFUNDED_OFFER' },
        },
      });

      const result = await orderManager.createLimitOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('tecUNFUNDED_OFFER');
    });
  });

  describe('createMarketOrder', () => {
    it('debe incluir el flag tfImmediateOrCancel', async () => {
      await orderManager.createMarketOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(mockAutofill).toHaveBeenCalledWith(
        expect.objectContaining({
          TransactionType: 'OfferCreate',
          Flags: 0x00080000, // tfImmediateOrCancel
        })
      );
    });
  });

  describe('cancelOrder', () => {
    it('debe generar un OfferCancel con el OfferSequence correcto', async () => {
      const offerSequence = 99;

      // Re-mock para OfferCancel
      mockAutofill.mockResolvedValue({
        TransactionType: 'OfferCancel',
        Account: mockWallet.address,
        OfferSequence: offerSequence,
      });

      await orderManager.cancelOrder(mockWallet, offerSequence);

      expect(mockAutofill).toHaveBeenCalledWith({
        TransactionType: 'OfferCancel',
        Account: mockWallet.address,
        OfferSequence: offerSequence,
      });
    });
  });
});
