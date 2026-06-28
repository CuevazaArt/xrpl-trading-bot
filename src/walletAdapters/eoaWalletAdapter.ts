import { AbstractWalletAdapter } from './AbstractWalletAdapter.js';
import { WalletBalance, WalletExecutionResult } from './IWalletProviderAdapter.js';
import { Client, Wallet, SubmittableTransaction } from 'xrpl';

export class EOAWalletAdapter extends AbstractWalletAdapter {
  readonly providerId = 'eoa';

  private client: Client;
  private seed: string | null;
  private wallet: Wallet | null = null;

  constructor(client: Client, seed: string | null) {
    super();
    this.client = client;
    this.seed = seed;
  }

  async initialize(): Promise<void> {
    if (!this.seed) {
      this.log.info('No se detectó semilla. Generando una nueva billetera local...');
      this.wallet = Wallet.generate();
      this.log.info(`Nueva billetera generada: ${this.wallet.address}`);
      return;
    }

    try {
      this.wallet = Wallet.fromSeed(this.seed);
      this.log.info(`Billetera cargada exitosamente: ${this.wallet.address}`);
    } catch (error) {
      this.log.error('Error al cargar la billetera desde la semilla:', error);
      throw error;
    }
  }

  isConfigured(): boolean {
    return !!this.wallet;
  }

  async getAddress(): Promise<string> {
    if (!this.wallet) throw new Error('Billetera no inicializada.');
    return this.wallet.address;
  }

  async getBalances(): Promise<WalletBalance> {
    if (!this.wallet) throw new Error('Billetera no inicializada.');

    let xrp = 0;
    let usd = 0;

    try {
      // 1. Obtener XRP
      const xrpVal = await this.client.getXrpBalance(this.wallet.address);
      xrp = parseFloat(String(xrpVal));
    } catch (error: any) {
      if (error.data && error.data.error !== 'actNotFound') {
        this.log.error('Error al obtener balance de XRP:', error);
      }
    }

    try {
      // 2. Obtener USD (Líneas de confianza)
      const response = await this.client.request({
        command: 'account_lines',
        account: this.wallet.address
      });
      const lines = response.result.lines || [];
      const usdLine = lines.find((line: any) => line.currency === 'USD');
      if (usdLine) {
        usd = parseFloat(usdLine.balance);
      }
    } catch (error: any) {
      if (error.data && error.data.error !== 'actNotFound') {
        this.log.error('Error al obtener balances de tokens:', error);
      }
    }

    return { xrp, usd };
  }

  async signAndExecute(txData: SubmittableTransaction): Promise<WalletExecutionResult> {
    if (!this.wallet) throw new Error('Billetera no inicializada.');

    try {
      // Completar campos requeridos y autofill
      const prepared = await this.client.autofill(txData);
      const signed = this.wallet.sign(prepared);
      
      const result = await this.client.submit(signed.tx_blob);
      const responseCode = result.result.engine_result;

      if (responseCode === 'tesSUCCESS') {
        return {
          success: true,
          txHash: signed.hash
        };
      } else {
        return {
          success: false,
          error: `Error de envío en XRPL: ${responseCode}`
        };
      }
    } catch (error: any) {
      this.log.error('Excepción al firmar/enviar transacción EOA:', error);
      return {
        success: false,
        error: error.message || String(error)
      };
    }
  }

  getUnderlyingWallet(): Wallet | null {
    return this.wallet;
  }
}
