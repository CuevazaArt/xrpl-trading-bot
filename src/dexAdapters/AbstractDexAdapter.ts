import { IDEXAdapter, QuoteRequest, QuoteResponse, ExecutionResult } from './IDEXAdapter.js';
import { createLogger } from '../logger.js';

/**
 * Clase abstracta base para todos los adaptadores DEX.
 * Proporciona logger estructurado integrado, control de estado y wrappers seguros.
 */
export abstract class AbstractDexAdapter implements IDEXAdapter {
  abstract readonly dexId: string;
  abstract readonly chainId: string;
  
  protected log: ReturnType<typeof createLogger>;
  protected isInitialized: boolean = false;

  constructor() {
    // Inicializar logger con el nombre del DEX concreto
    this.log = createLogger(`DEX:${this.constructor.name}`);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    try {
      this.log.info(`Inicializando adaptador para ${this.dexId} en red ${this.chainId}...`);
      await this.onInitialize();
      this.isInitialized = true;
      this.log.info(`Adaptador ${this.dexId} listo.`);
    } catch (error: any) {
      this.log.error(`Fallo crítico al inicializar el adaptador ${this.dexId}:`, error);
      throw error; // Propagar error crítico al inicio
    }
  }

  /**
   * Implementación específica de arranque de cada DEX.
   */
  protected abstract onInitialize(): Promise<void>;

  /**
   * Wrapper seguro para obtener cotizaciones que captura excepciones no controladas.
   */
  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    if (!this.isInitialized) {
      return {
        success: false,
        inputAmount: request.amount,
        outputAmount: '0',
        priceImpactPct: 0,
        expectedOutput: '0',
        executionRoute: null,
        error: `Adaptador ${this.dexId} no inicializado.`
      };
    }
    
    // Timeout guard: 5 segundos máximo para evitar llamadas colgadas
    const TIMEOUT_MS = 5000;
    try {
      return await Promise.race([
        this.performGetQuote(request),
        new Promise<QuoteResponse>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de consulta excedido (5s)')), TIMEOUT_MS)
        )
      ]);
    } catch (error: any) {
      this.log.error(`Error al obtener cotización en ${this.dexId}:`, error.message || error);
      return {
        success: false,
        inputAmount: request.amount,
        outputAmount: '0',
        priceImpactPct: 0,
        expectedOutput: '0',
        executionRoute: null,
        error: error.message || String(error)
      };
    }
  }

  protected abstract performGetQuote(request: QuoteRequest): Promise<QuoteResponse>;

  /**
   * Wrapper seguro para ejecución de swaps que garantiza no propagar excepciones de red.
   */
  async executeSwap(wallet: any, quote: QuoteResponse): Promise<ExecutionResult> {
    if (!this.isInitialized) {
      return { success: false, error: 'Adaptador no inicializado.' };
    }
    if (!quote.success) {
      return { success: false, error: 'No se puede ejecutar un swap con una cotización inválida.' };
    }

    const TIMEOUT_MS = 10000; // 10s timeout para ejecuciones
    try {
      this.log.info(`Ejecutando swap en ${this.dexId}...`);
      const result = await Promise.race([
        this.performExecuteSwap(wallet, quote),
        new Promise<ExecutionResult>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de ejecución de swap (10s)')), TIMEOUT_MS)
        )
      ]);
      if (result.success) {
        this.log.info(`✅ Swap exitoso en ${this.dexId}. Hash: ${result.txHash}`);
      } else {
        this.log.error(`❌ Swap fallido en ${this.dexId}: ${result.error}`);
      }
      return result;
    } catch (error: any) {
      this.log.error(`Excepción fatal durante executeSwap en ${this.dexId}:`, error.message || error);
      return {
        success: false,
        error: error.message || String(error)
      };
    }
  }

  protected abstract performExecuteSwap(wallet: any, quote: QuoteResponse): Promise<ExecutionResult>;

  async checkHealth(): Promise<{ online: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const healthy = await this.performHealthCheck();
      return {
        online: healthy,
        latencyMs: Date.now() - start
      };
    } catch {
      return {
        online: false,
        latencyMs: Date.now() - start
      };
    }
  }

  protected abstract performHealthCheck(): Promise<boolean>;

  async shutdown(): Promise<void> {
    try {
      await this.onShutdown();
      this.isInitialized = false;
      this.log.info(`Adaptador ${this.dexId} apagado correctamente.`);
    } catch (error) {
      this.log.error(`Error al apagar el adaptador ${this.dexId}:`, error);
    }
  }

  protected abstract onShutdown(): Promise<void>;
}
