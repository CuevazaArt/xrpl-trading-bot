import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del Client de XRPL — usa submit() (HFT async), no submitAndWait
const mockAutofill = vi.fn();
const mockSubmit = vi.fn();

const mockClient = {
  autofill: mockAutofill,
  submit: mockSubmit,
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

    // Configurar mocks por defecto para transacciones exitosas (formato HFT submit)
    mockAutofill.mockResolvedValue({
      TransactionType: 'OfferCreate',
      Account: mockWallet.address,
      Sequence: 42,
    });
    mockSubmit.mockResolvedValue({
      result: {
        engine_result: 'tesSUCCESS',
        tx_json: {
          hash: 'ABC123HASH',
          Sequence: 42,
        },
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

    it('debe firmar y enviar la transacción via submit (HFT)', async () => {
      await orderManager.createLimitOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(mockWallet.sign).toHaveBeenCalled();
      expect(mockSubmit).toHaveBeenCalledWith('signed_blob_hex');
    });

    it('debe retornar success=true y hash cuando tesSUCCESS', async () => {
      const result = await orderManager.createLimitOrder(mockWallet, '10000000', { currency: 'USD', value: '5', issuer: 'r1' });

      expect(result.success).toBe(true);
      expect(result.hash).toBe('ABC123HASH');
      expect(result.sequence).toBe(42);
    });

    it('debe retornar success=false cuando la transacción falla', async () => {
      mockSubmit.mockResolvedValue({
        result: {
          engine_result: 'tecUNFUNDED_OFFER',
          tx_json: {
            hash: 'FAIL_HASH',
            Sequence: 43,
          },
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
        Sequence: 50,
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
