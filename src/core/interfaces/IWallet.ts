/**
 * Universal wallet abstraction.
 * Hides chain-specific signing and key management.
 */

export interface IWallet {
  readonly address: string;
  readonly chain: string;

  sign(payload: unknown): Promise<string>;
  getNativeBalance(): Promise<number>;
}

export interface IWalletFactory {
  fromSeed(seed: string): Promise<IWallet>;
  fromPrivateKey?(key: string): Promise<IWallet>;
  fromKeyfile?(path: string, password: string): Promise<IWallet>;
}
