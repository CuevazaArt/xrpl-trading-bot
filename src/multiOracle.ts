import { createLogger } from './logger.js';
import { config } from './config.js';
import { isMainThread, parentPort } from 'worker_threads';

const log = createLogger('MultiOracle');

let latestConsensusFromParent: ConsensusPrice | null = null;

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'price_update') {
      latestConsensusFromParent = msg.consensus;
    }
  });
}

// =====================================================================
// TIPOS PÚBLICOS
// =====================================================================

export interface OracleQuote {
  source: string;
  price: number;
  timestamp: number;
  healthy: boolean;
  latencyMs: number;
}

export interface ConsensusPrice {
  price: number;           // Mediana ponderada
  spread: number;          // Max - Min de las fuentes válidas
  sources: OracleQuote[];  // Detalle por fuente
  confidence: number;      // 0-1, basado en concordancia y cantidad de fuentes
  timestamp: number;
}

// =====================================================================
// CONFIGURACIÓN DE FUENTES
// =====================================================================

interface OracleSourceConfig {
  name: string;
  url: string;
  weight: number;
  extractPrice: (data: any) => number;
}

const ORACLE_SOURCES: OracleSourceConfig[] = [
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/XRP-USD/spot',
    weight: 1.0,
    extractPrice: (data) => parseFloat(data.data?.amount),
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT',
    weight: 1.0,
    extractPrice: (data) => parseFloat(data.price),
  },
  {
    name: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XRPUSD',
    weight: 0.8,
    extractPrice: (data) => {
      // Kraken usa claves como XXRPZUSD o XRPUSD
      const pairs = data.result;
      if (!pairs) return NaN;
      const key = Object.keys(pairs)[0];
      if (!key) return NaN;
      // 'c' = last trade closed [price, lot-volume]
      return parseFloat(pairs[key].c[0]);
    },
  },
  {
    name: 'CryptoCompare',
    url: 'https://min-api.cryptocompare.com/data/price?fsym=XRP&tsyms=USD',
    weight: 0.6,
    extractPrice: (data) => parseFloat(data.USD),
  },
];

// =====================================================================
// ESTADO INTERNO POR FUENTE
// =====================================================================

interface SourceState {
  lastPrice: number;
  lastFetchTime: number;
  consecutiveFailures: number;
  healthy: boolean;
}

// =====================================================================
// MULTI ORACLE
// =====================================================================

/**
 * Agregador de precios multi-fuente con:
 * - Fetch paralelo con timeout por fuente
 * - Outlier rejection (>2% de la mediana)
 * - Mediana ponderada como precio de consenso
 * - Confidence score basado en concordancia
 * - Circuit breaker individual por fuente
 * - Caché de 2 segundos
 */
export class MultiOracle {
  private sourceStates: Map<string, SourceState> = new Map();
  private cachedConsensus: ConsensusPrice | null = null;
  private lastConsensusTime: number = 0;

  // Configuración
  private readonly cacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly outlierThresholdPct: number;
  private readonly minSources: number;
  private readonly maxConsecutiveFailures: number;

  constructor(options?: {
    cacheTtlMs?: number;
    fetchTimeoutMs?: number;
    outlierThresholdPct?: number;
    minSources?: number;
    maxConsecutiveFailures?: number;
  }) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 2000;
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? 2000;
    this.outlierThresholdPct = options?.outlierThresholdPct ?? 2.0;
    this.minSources = options?.minSources ?? 2;
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 5;

    // Inicializar estado por fuente
    for (const source of ORACLE_SOURCES) {
      this.sourceStates.set(source.name, {
        lastPrice: 0,
        lastFetchTime: 0,
        consecutiveFailures: 0,
        healthy: true,
      });
    }
  }

  /**
   * Obtiene el precio de consenso multi-fuente.
   * Retorna null si no hay suficientes fuentes concordantes.
   */
  async getConsensusPrice(): Promise<ConsensusPrice | null> {
    if (!isMainThread) {
      return latestConsensusFromParent;
    }
    const now = Date.now();

    // 1. Retornar desde caché si es válido
    if (this.cachedConsensus && (now - this.lastConsensusTime) < this.cacheTtlMs) {
      return this.cachedConsensus;
    }

    // 2. Fetch paralelo de todas las fuentes
    const quotes = await this.fetchAllSources();

    // 3. Filtrar fuentes exitosas
    const validQuotes = quotes.filter(q => q.healthy && q.price > 0);

    if (validQuotes.length < this.minSources) {
      log.warn(`Solo ${validQuotes.length}/${this.minSources} fuentes válidas. Insuficiente para consenso.`);

      // Intentar usar el último consenso si no es muy viejo
      if (this.cachedConsensus && (now - this.lastConsensusTime) < 30000) {
        log.warn(`Usando último consenso (${((now - this.lastConsensusTime) / 1000).toFixed(1)}s ago).`);
        return { ...this.cachedConsensus, confidence: this.cachedConsensus.confidence * 0.5 };
      }
      return null;
    }

    // 4. Calcular mediana simple para outlier detection
    const sortedPrices = validQuotes.map(q => q.price).sort((a, b) => a - b);
    const rawMedian = this.computeMedian(sortedPrices);

    // 5. Rechazar outliers (>2% de la mediana)
    const threshold = rawMedian * (this.outlierThresholdPct / 100);
    const filteredQuotes = validQuotes.filter(q => {
      const deviation = Math.abs(q.price - rawMedian);
      if (deviation > threshold) {
        log.warn(`Outlier rechazado: ${q.source} reportó ${q.price.toFixed(4)} (desvía ${((deviation / rawMedian) * 100).toFixed(2)}% de mediana ${rawMedian.toFixed(4)})`);
        return false;
      }
      return true;
    });

    if (filteredQuotes.length < this.minSources) {
      log.warn(`Solo ${filteredQuotes.length} fuentes tras filtrar outliers. Insuficiente.`);
      return null;
    }

    // 6. Calcular mediana ponderada
    const consensusPrice = this.computeWeightedMedian(filteredQuotes);

    // 7. Calcular spread y confidence
    const prices = filteredQuotes.map(q => q.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const spreadPct = ((maxPrice - minPrice) / consensusPrice) * 100;

    // Confidence: basada en número de fuentes + concordancia (spread bajo)
    const sourceFactor = Math.min(1, filteredQuotes.length / ORACLE_SOURCES.length);
    const spreadFactor = Math.max(0, 1 - spreadPct / 1.0); // spread > 1% = 0 confidence
    const confidence = sourceFactor * 0.5 + spreadFactor * 0.5;

    const consensus: ConsensusPrice = {
      price: consensusPrice,
      spread: maxPrice - minPrice,
      sources: quotes, // Incluir TODAS las fuentes (healthy + unhealthy) para visibilidad
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: now,
    };

    // 8. Cachear
    this.cachedConsensus = consensus;
    this.lastConsensusTime = now;

    log.debug(`Consenso: ${consensusPrice.toFixed(4)} USD (${filteredQuotes.length} fuentes, confianza: ${(confidence * 100).toFixed(0)}%, spread: ${spreadPct.toFixed(3)}%)`);

    return consensus;
  }

  /**
   * Retorna el estado de salud de cada fuente individualmente.
   */
  getSourceHealth(): Record<string, { healthy: boolean; lastPrice: number; failures: number }> {
    const health: Record<string, { healthy: boolean; lastPrice: number; failures: number }> = {};
    for (const [name, state] of this.sourceStates) {
      health[name] = {
        healthy: state.healthy,
        lastPrice: state.lastPrice,
        failures: state.consecutiveFailures,
      };
    }
    return health;
  }

  // =====================================================================
  // FETCH PARALELO
  // =====================================================================

  private async fetchAllSources(): Promise<OracleQuote[]> {
    const promises = ORACLE_SOURCES.map(source => this.fetchSingleSource(source));
    return Promise.all(promises);
  }

  private async fetchSingleSource(source: OracleSourceConfig): Promise<OracleQuote> {
    // Verificar si la fuente está desactivada en la configuración
    if (
      process.env.NODE_ENV !== 'test' && (
        (source.name === 'CryptoCompare' && config.disableCryptoCompare) ||
        (source.name === 'Binance' && config.disableBinanceOracle) ||
        (source.name === 'Kraken' && config.disableKrakenOracle) ||
        (source.name === 'Coinbase' && config.disableCoinbaseOracle)
      )
    ) {
      return {
        source: source.name,
        price: 0,
        timestamp: 0,
        healthy: false,
        latencyMs: 0,
      };
    }

    const state = this.sourceStates.get(source.name)!;
    const startTime = Date.now();

    // Circuit breaker: si demasiados fallos, intentar cada 30s en vez de cada tick
    if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      if (Date.now() - state.lastFetchTime < 30000) {
        return {
          source: source.name,
          price: state.lastPrice,
          timestamp: state.lastFetchTime,
          healthy: false,
          latencyMs: 0,
        };
      }
      // Resetear para reintentar
      state.consecutiveFailures = 0;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

      const response = await fetch(source.url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const price = source.extractPrice(data);
      const latencyMs = Date.now() - startTime;

      if (isNaN(price) || price <= 0) {
        throw new Error(`Precio inválido: ${price}`);
      }

      // Éxito — actualizar estado
      state.lastPrice = price;
      state.lastFetchTime = Date.now();
      state.consecutiveFailures = 0;
      state.healthy = true;

      return {
        source: source.name,
        price,
        timestamp: Date.now(),
        healthy: true,
        latencyMs,
      };
    } catch (error) {
      state.consecutiveFailures++;
      state.healthy = state.consecutiveFailures < this.maxConsecutiveFailures;

      const errMsg = error instanceof Error ? error.message : String(error);
      if (state.consecutiveFailures <= 2) {
        // Solo logear los primeros fallos, no spamear
        log.warn(`${source.name} falló (${state.consecutiveFailures}): ${errMsg}`);
      }

      return {
        source: source.name,
        price: state.lastPrice, // Último precio conocido
        timestamp: state.lastFetchTime,
        healthy: false,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  // =====================================================================
  // CÁLCULOS MATEMÁTICOS
  // =====================================================================

  private computeMedian(sortedValues: number[]): number {
    const n = sortedValues.length;
    if (n === 0) return 0;
    if (n % 2 === 1) return sortedValues[Math.floor(n / 2)];
    return (sortedValues[n / 2 - 1] + sortedValues[n / 2]) / 2;
  }

  private computeWeightedMedian(quotes: OracleQuote[]): number {
    // Para arbitraje, la mediana ponderada se aproxima:
    // 1. Ordenar por precio
    // 2. Acumular pesos hasta llegar al 50%
    const sourceConfigs = ORACLE_SOURCES.reduce((map, s) => {
      map.set(s.name, s.weight);
      return map;
    }, new Map<string, number>());

    const weighted = quotes
      .map(q => ({ price: q.price, weight: sourceConfigs.get(q.source) || 1.0 }))
      .sort((a, b) => a.price - b.price);

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    const halfWeight = totalWeight / 2;

    let accWeight = 0;
    for (const w of weighted) {
      accWeight += w.weight;
      if (accWeight >= halfWeight) {
        return w.price;
      }
    }

    // Fallback: promedio simple
    return quotes.reduce((sum, q) => sum + q.price, 0) / quotes.length;
  }
}
