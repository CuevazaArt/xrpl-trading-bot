export interface CEXOrderResult {
  success: boolean;
  orderId: string;
  filledQty: number;
  filledPrice: number;
  commission: number;
  commissionAsset: string;
  status: string;
  error?: string;
}

export interface CEXBalance {
  xrp: number;
  usd: number; // USDT o USD
}

export interface CEXTicker {
  bidPrice: number;
  askPrice: number;
  lastPrice: number;
  volume24h: number;
  timestamp: number;
}

export interface ICEXAdapter {
  readonly cexId: string;
  
  /**
   * Indica si las claves API necesarias están configuradas.
   */
  isConfigured(): boolean;
  
  /**
   * Obtiene las puntas bid/ask del libro de órdenes del CEX.
   */
  getTicker(): Promise<CEXTicker | null>;
  
  /**
   * Ejecuta una orden a mercado (BUY).
   */
  marketBuy(qtyXrp: number): Promise<CEXOrderResult>;
  
  /**
   * Ejecuta una orden a mercado (SELL).
   */
  marketSell(qtyXrp: number): Promise<CEXOrderResult>;
  
  /**
   * Ejecuta una orden límite inmediata o cancelada (IOC).
   */
  limitIOC(side: 'BUY' | 'SELL', qtyXrp: number, limitPrice: number): Promise<CEXOrderResult>;
  
  /**
   * Obtiene los balances disponibles de XRP y moneda cotizada (USDT/USD).
   */
  getBalances(): Promise<CEXBalance>;
}
