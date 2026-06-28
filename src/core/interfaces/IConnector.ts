import { EventEmitter } from 'events';
import type {
  ClusterType,
  ConnectorCapability,
  TradingPair,
  LimitOrderParams,
  MarketOrderParams,
  OrderResult,
  CancelResult,
  ActiveOrder,
  AssetBalance,
  OrderBook,
  Ticker,
  FillEvent,
  PriceUpdate,
  OrderUpdate,
} from './types.js';

/**
 * Universal connector interface for all exchanges and DEXes.
 *
 * Strategies ONLY interact with this interface — they never know
 * which chain or exchange they're running on.
 */
export interface IConnector {
  readonly name: string;
  readonly cluster: ClusterType;
  readonly capabilities: ConnectorCapability[];

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Orders
  placeLimitOrder(params: LimitOrderParams): Promise<OrderResult>;
  placeMarketOrder(params: MarketOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<CancelResult>;
  getActiveOrders(pair?: TradingPair): Promise<ActiveOrder[]>;

  // Data
  getBalance(asset: string): Promise<AssetBalance>;
  getOrderBook(pair: TradingPair, depth?: number): Promise<OrderBook>;
  getTicker(pair: TradingPair): Promise<Ticker>;

  // Events
  on(event: 'fill', callback: (fill: FillEvent) => void): this;
  on(event: 'priceUpdate', callback: (update: PriceUpdate) => void): this;
  on(event: 'orderUpdate', callback: (update: OrderUpdate) => void): this;
  on(event: 'connected' | 'disconnected' | 'error', callback: (...args: any[]) => void): this;

  // Capability checking
  hasCapability(cap: ConnectorCapability): boolean;
}

/**
 * Base class for connector implementations.
 * Provides EventEmitter functionality and capability checking.
 */
export abstract class BaseConnector extends EventEmitter implements IConnector {
  abstract readonly name: string;
  abstract readonly cluster: ClusterType;
  abstract readonly capabilities: ConnectorCapability[];

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;

  abstract placeLimitOrder(params: LimitOrderParams): Promise<OrderResult>;
  abstract placeMarketOrder(params: MarketOrderParams): Promise<OrderResult>;
  abstract cancelOrder(orderId: string): Promise<CancelResult>;
  abstract getActiveOrders(pair?: TradingPair): Promise<ActiveOrder[]>;

  abstract getBalance(asset: string): Promise<AssetBalance>;
  abstract getOrderBook(pair: TradingPair, depth?: number): Promise<OrderBook>;
  abstract getTicker(pair: TradingPair): Promise<Ticker>;

  hasCapability(cap: ConnectorCapability): boolean {
    return this.capabilities.includes(cap);
  }

  requireCapability(cap: ConnectorCapability): void {
    if (!this.hasCapability(cap)) {
      throw new Error(`Connector '${this.name}' does not support capability: ${cap}`);
    }
  }
}
