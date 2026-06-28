/**
 * Barrel export for all core interfaces.
 *
 * Usage:
 *   import { IConnector, IStrategyV2, TradingPair } from '../core/interfaces/index.js';
 */

// Shared types
export type {
  ClusterType,
  OrderSide,
  OrderType,
  OrderStatus,
  AssetDescriptor,
  TradingPair,
  AssetBalance,
  OrderBookLevel,
  OrderBook,
  Ticker,
  LimitOrderParams,
  MarketOrderParams,
  OrderResult,
  CancelResult,
  ActiveOrder,
  FillEvent,
  PriceUpdate,
  OrderUpdate,
  TickState,
  ConnectorCapability,
} from './types.js';

// Connector
export type { IConnector } from './IConnector.js';
export { BaseConnector } from './IConnector.js';

// Strategy
export type { IStrategyV2, StrategyContext } from './IStrategyV2.js';
export { AbstractStrategyV2 } from './IStrategyV2.js';

// Oracle
export type {
  IOracle,
  OracleQuote,
  ConsensusPrice,
  SourceHealth,
  OracleSourceConfig,
} from './IOracle.js';

// Wallet
export type { IWallet, IWalletFactory } from './IWallet.js';
