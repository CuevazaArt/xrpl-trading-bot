import { IWalletProviderAdapter, WalletBalance, WalletExecutionResult } from './IWalletProviderAdapter.js';
import { createLogger } from '../logger.js';

export abstract class AbstractWalletAdapter implements IWalletProviderAdapter {
  abstract readonly providerId: string;
  protected log: ReturnType<typeof createLogger>;

  constructor() {
    this.log = createLogger(`Wallet:${this.constructor.name}`);
  }

  abstract initialize(): Promise<void>;
  abstract isConfigured(): boolean;
  abstract getAddress(): Promise<string>;
  abstract getBalances(): Promise<WalletBalance>;
  abstract signAndExecute(txData: any): Promise<WalletExecutionResult>;
}
