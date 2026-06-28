/**
 * Oracle interface for price feeds.
 * Abstracts the source of market prices.
 */

export interface OracleQuote {
  source: string;
  price: number;
  timestamp: number;
  healthy: boolean;
  latencyMs: number;
}

export interface ConsensusPrice {
  price: number;
  spread: number;
  sources: OracleQuote[];
  confidence: number;
  timestamp: number;
}

export interface SourceHealth {
  name: string;
  healthy: boolean;
  lastPrice: number;
  lastFetchTime: number;
  consecutiveFailures: number;
}

export interface IOracle {
  getConsensusPrice(): Promise<ConsensusPrice | null>;
  getSourceHealth(): Record<string, SourceHealth>;
  addSource?(source: OracleSourceConfig): void;
  removeSource?(name: string): void;
}

export interface OracleSourceConfig {
  name: string;
  weight: number;
  fetchPrice: () => Promise<number>;
  wsUrl?: string;
}
