import { AbstractDexAdapter } from './AbstractDexAdapter.js';
import { QuoteRequest, QuoteResponse, ExecutionResult } from './IDEXAdapter.js';

/**
 * Adaptador DEX de Simulación (Mock) para pruebas y validación.
 * Emula la respuesta de cotización y ejecución bajo las reglas unificadas.
 */
export class MockDexAdapter extends AbstractDexAdapter {
  readonly dexId = 'mock_dex';
  readonly chainId = 'testnet_sim';

  private simulatedLatencyMs = 50;

  protected async onInitialize(): Promise<void> {
    // Simular carga de configuraciones
    await new Promise(resolve => setTimeout(resolve, this.simulatedLatencyMs));
  }

  protected async performGetQuote(request: QuoteRequest): Promise<QuoteResponse> {
    await new Promise(resolve => setTimeout(resolve, this.simulatedLatencyMs));

    const inputVal = parseFloat(request.amount);
    if (isNaN(inputVal) || inputVal <= 0) {
      throw new Error('Cantidad a cotizar inválida.');
    }

    // Tasa de cambio simulada: 1 XRP = 1.05 USD
    const rate = 1.05;
    const outputVal = inputVal * rate;

    return {
      success: true,
      inputAmount: request.amount,
      outputAmount: outputVal.toString(),
      priceImpactPct: 0.05, // 0.05%
      expectedOutput: (outputVal * (1 - request.slippagePct / 100)).toString(),
      executionRoute: { path: [request.fromToken.currency, request.toToken.currency] }
    };
  }

  protected async performExecuteSwap(wallet: any, quote: QuoteResponse): Promise<ExecutionResult> {
    await new Promise(resolve => setTimeout(resolve, this.simulatedLatencyMs * 2));

    if (!wallet) {
      throw new Error('Wallet inválido para firmar swap.');
    }

    // Generar un hash de transacción simulada
    const hash = 'MOCK_TX_' + Math.random().toString(36).slice(2, 10).toUpperCase();

    return {
      success: true,
      txHash: hash,
      executedPrice: parseFloat(quote.outputAmount) / parseFloat(quote.inputAmount),
      feePaid: '12' // 12 drops
    };
  }

  protected async performHealthCheck(): Promise<boolean> {
    return true;
  }

  protected async onShutdown(): Promise<void> {
    // Nada que liberar en el simulador
  }
}
