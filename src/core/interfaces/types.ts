/**
 * Shared types for the modular trading platform.
 * These types are chain-agnostic and used across all connectors and strategies.
 */

// =====================================================================
// ENUMS
// =====================================================================

export type ClusterType = 'xrpl' | 'cex' | 'evm' | 'solana';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC';
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

// =====================================================================
// ASSET & TRADING PAIR
// =====================================================================

export interface AssetDescriptor {
  symbol: string;
  chain: string;
  address?: string;
  decimals: number;
}

export interface TradingPair {
  base: AssetDescriptor;
  quote: AssetDescriptor;
}

// =====================================================================
// BALANCES
// =====================================================================

export interface AssetBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

// =====================================================================
// ORDER BOOK
// =====================================================================

export interface OrderBookLevel {
  price: number;
  amount: number;
}

export interface OrderBook {
  pair: TradingPair;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

// =====================================================================
// TICKER
// =====================================================================

export interface Ticker {
  pair: TradingPair;
  bidPrice: number;
  askPrice: number;
  lastPrice: number;
  volume24h: number;
  timestamp: number;
}

// =====================================================================
// ORDERS
// =====================================================================

export interface LimitOrderParams {
  pair: TradingPair;
  side: OrderSide;
  price: number;
  amount: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface MarketOrderParams {
  pair: TradingPair;
  side: OrderSide;
  amount: number;
}

export interface OrderResult {
  success: boolean;
  orderId: string;
  hash?: string;
  status: OrderStatus;
  filledAmount?: number;
  filledPrice?: number;
  fee?: number;
  feeAsset?: string;
  error?: string;
}

export interface CancelResult {
  success: boolean;
  orderId: string;
  hash?: string;
  error?: string;
}

export interface ActiveOrder {
  orderId: string;
  pair: TradingPair;
  side: OrderSide;
  type: OrderType;
  price: number;
  amount: number;
  filledAmount: number;
  status: OrderStatus;
  createdAt: number;
}

// =====================================================================
// EVENTS
// =====================================================================

export interface FillEvent {
  orderId: string;
  pair: TradingPair;
  side: OrderSide;
  price: number;
  amount: number;
  fee: number;
  feeAsset: string;
  hash?: string;
  timestamp: number;
}

export interface PriceUpdate {
  pair: TradingPair;
  price: number;
  source: string;
  timestamp: number;
}

export interface OrderUpdate {
  orderId: string;
  status: OrderStatus;
  filledAmount?: number;
  filledPrice?: number;
  timestamp: number;
}

// =====================================================================
// STRATEGY CONTEXT
// =====================================================================

export interface TickState {
  timestamp: number;
  blockNumber: number;
  marketPrice: number;
  tickCount: number;
}

// =====================================================================
// CONNECTOR CAPABILITIES
// =====================================================================

export type ConnectorCapability =
  | 'LIMIT_ORDERS'
  | 'MARKET_ORDERS'
  | 'IOC_ORDERS'
  | 'CANCEL_ORDERS'
  | 'STREAMING_PRICES'
  | 'STREAMING_FILLS'
  | 'ORDER_BOOK'
  | 'MULTI_ASSET'
  | 'WEBSOCKET';
