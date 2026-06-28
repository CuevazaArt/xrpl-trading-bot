export interface WalletBalance {
  xrp: number;
  usd: number;
}

export interface WalletExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface IWalletProviderAdapter {
  readonly providerId: string;

  /**
   * Inicializa la conexión del proveedor de billeteras si es necesario.
   */
  initialize(): Promise<void>;

  /**
   * Retorna si la billetera está configurada con las credenciales requeridas.
   */
  isConfigured(): boolean;

  /**
   * Obtiene la dirección pública de la cuenta gestionada.
   */
  getAddress(): Promise<string>;

  /**
   * Obtiene los balances de XRP y USD.
   */
  getBalances(): Promise<WalletBalance>;

  /**
   * Firma y ejecuta una transacción local u on-chain.
   */
  signAndExecute(txData: any): Promise<WalletExecutionResult>;
}
