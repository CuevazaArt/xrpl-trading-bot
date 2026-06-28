import type { IConnector } from './IConnector.js';
import type { TickState, ConnectorCapability } from './types.js';
import type { IOracle } from './IOracle.js';
import type { Logger } from '../../logger.js';

/**
 * Context injected into every strategy at initialization.
 */
export interface StrategyContext {
  connector: IConnector;
  oracle: IOracle;
  config: Record<string, any>;
  logger: Logger;
  instanceId: string;
}

/**
 * Chain-agnostic strategy interface (v2).
 * Strategies implementing this can run on ANY connector.
 */
export interface IStrategyV2 {
  readonly name: string;
  readonly displayName: string;
  readonly requiredCapabilities: ConnectorCapability[];

  init(ctx: StrategyContext): Promise<void>;
  tick(state: TickState): Promise<void>;
  cleanup(): Promise<void>;
  getStatus(): Record<string, string | number | boolean>;
}

/**
 * Abstract base for v2 strategies.
 * Provides common patterns and enforces capability validation.
 */
export abstract class AbstractStrategyV2 implements IStrategyV2 {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly requiredCapabilities: ConnectorCapability[];

  protected ctx!: StrategyContext;
  protected connector!: IConnector;
  protected oracle!: IOracle;
  protected log!: Logger;

  async init(ctx: StrategyContext): Promise<void> {
    this.ctx = ctx;
    this.connector = ctx.connector;
    this.oracle = ctx.oracle;
    this.log = ctx.logger;

    // Validate connector capabilities
    for (const cap of this.requiredCapabilities) {
      if (!this.connector.hasCapability(cap)) {
        throw new Error(
          `Strategy '${this.name}' requires '${cap}' but connector '${this.connector.name}' does not support it.`
        );
      }
    }

    await this.onInit();
  }

  protected abstract onInit(): Promise<void>;
  abstract tick(state: TickState): Promise<void>;
  abstract cleanup(): Promise<void>;

  getStatus(): Record<string, string | number | boolean> {
    return {
      strategy: this.name,
      connector: this.connector?.name ?? 'not initialized',
      connected: this.connector?.isConnected() ?? false,
    };
  }
}
