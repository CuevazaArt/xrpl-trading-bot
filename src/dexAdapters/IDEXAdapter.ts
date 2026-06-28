export interface TokenAmount {
  currency: string;
  value: string;
  issuer?: string; // Requerido para tokens de red (ej. XRPL IOUs o ERC-20)
}

export interface QuoteRequest {
  fromToken: TokenAmount;
  toToken: TokenAmount;
  amount: string;
  slippagePct: number;
}

export interface QuoteResponse {
  success: boolean;
  inputAmount: string;
  outputAmount: string;
  priceImpactPct: number;
  expectedOutput: string;
  executionRoute: any; // Datos específicos del enrutador de cada DEX
  error?: string;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  executedPrice?: number;
  feePaid?: string;
}

export interface IDEXAdapter {
  readonly dexId: string;
  readonly chainId: string;
  
  /**
   * Inicializa las conexiones, WebSocket streams o carga configuraciones necesarias.
   */
  initialize(): Promise<void>;
  
  /**
   * Obtiene una cotización en tiempo real para un swap.
   */
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  
  /**
   * Ejecuta el intercambio físico (DEX swap) firmando y enviando a la red.
   */
  executeSwap(wallet: any, quote: QuoteResponse): Promise<ExecutionResult>;
  
  /**
   * Verifica la salud y estado operativo de las APIs o contratos del DEX.
   */
  checkHealth(): Promise<{ online: boolean; latencyMs: number }>;
  
  /**
   * Libera recursos y cierra conexiones persistentes.
   */
  shutdown(): Promise<void>;
}
