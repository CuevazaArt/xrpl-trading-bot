import { AbstractWalletAdapter } from './AbstractWalletAdapter.js';
import { WalletBalance, WalletExecutionResult } from './IWalletProviderAdapter.js';

export class MockWalletAdapter extends AbstractWalletAdapter {
  readonly providerId = 'mock_wallet';

  private address = 'rMOCKWALLETXXXXXXXXXXXXXXX';
  private xrpBalance = 1000;
  private usdBalance = 500;

  async initialize(): Promise<void> {
    this.log.info('Inicializado adaptador mock de billetera.');
  }

  isConfigured(): boolean {
    return true;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async getBalances(): Promise<WalletBalance> {
    return {
      xrp: this.xrpBalance,
      usd: this.usdBalance
    };
  }

  async signAndExecute(txData: any): Promise<WalletExecutionResult> {
    const hash = 'MOCK_TX_' + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    // Simular ejecución y actualización de balances locales
    if (txData.TransactionType === 'Payment') {
      const amount = txData.Amount;
      if (typeof amount === 'string') {
        const valXrp = parseFloat(amount) / 1000000;
        this.xrpBalance -= valXrp;
      } else if (amount && amount.currency === 'USD') {
        const valUsd = parseFloat(amount.value);
        if (txData.DeliverMin) {
          // Es un swap (venta de XRP por USD)
          this.usdBalance += valUsd;
        } else {
          this.usdBalance -= valUsd;
        }
      }
    }
    
    return {
      success: true,
      txHash: hash
    };
  }
}
