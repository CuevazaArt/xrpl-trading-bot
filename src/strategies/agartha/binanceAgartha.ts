import { BinanceSpotClient, BinanceSymbolFilter } from '../../cexAdapters/binanceSpotClient.js';
import { db } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('BinanceAgartha');

export interface BinanceAgarthaSymbolState {
  symbol: string;
  positionQty: number;
  entryPrice: number;
  peakPrice: number;
  isTrailingActive: boolean;
  minPriceSinceTracking: number;
  buyState: 'WAITING_FOR_TRIGGER' | 'IN_POSITION' | 'LIQUIDATING';
  ledgersInPosition: number;
  entryTimestamp?: number;
}

export interface BinanceAgarthaConfig {
  symbols: string[];
  notionalUsdt: number;
  trailingEntryPct: number;
  trailingExitPct: number;
  activationProfitPct: number;
  maxHoldingMinutes: number;
  maxConcurrentPositions: number; // Límite para atajar la restricción de capital
}

export class BinanceAgarthaStrategy {
  private client: BinanceSpotClient;
  private config: BinanceAgarthaConfig;
  private states: Record<string, BinanceAgarthaSymbolState> = {};
  private filters: Record<string, BinanceSymbolFilter> = {};
  private blacklist: string[] = ['PUMP', 'FUN', 'SCAM', 'RUG'];
  private lastEquityLogTimestamp = 0;

  constructor(client: BinanceSpotClient, config: BinanceAgarthaConfig) {
    this.client = client;
    this.config = config;
  }

  async init(): Promise<void> {
    this.loadState();
    
    // Cargar lista negra personalizada si existe en DB
    const savedBlacklist = db.getCustomData('agartha_binance_blacklist');
    if (savedBlacklist && Array.isArray(savedBlacklist)) {
      this.blacklist = savedBlacklist;
    } else {
      db.saveCustomData('agartha_binance_blacklist', this.blacklist);
    }

    log.info(`Inicializando Agartha en Binance. Cargados ${this.config.symbols.length} símbolos candidatos del catálogo Alpha.`);
    
    // 1. Obtener TODOS los filtros de Binance Spot de una sola vez sin parámetros (peso = 10)
    const allFilters = await this.client.getExchangeInfo();
    
    const validSymbols: string[] = [];
    this.filters = {};

    for (const s of this.config.symbols) {
      const symbolUpper = s.toUpperCase();
      const marketSymbol = `${symbolUpper}USDT`;
      
      // Solo incluimos símbolos que existen y están listados en Binance Spot
      if (allFilters[marketSymbol]) {
        const filter = allFilters[marketSymbol];
        if (filter.status === 'TRADING') {
          this.filters[marketSymbol] = filter;
          validSymbols.push(symbolUpper);
        }
      }
    }
    
    // 2. Sobrescribir la lista de símbolos activos con los realmente negociables
    const totalOriginal = this.config.symbols.length;
    this.config.symbols = validSymbols;
    
    log.info(`✅ Filtrado completado: De ${totalOriginal} símbolos Alpha analizados, ${validSymbols.length} son negociables contra USDT en Binance Spot.`);
    log.info(`Símbolos activos para trading: [${this.config.symbols.join(', ')}]`);
    log.info(`Límite de posiciones concurrentes configurado: ${this.config.maxConcurrentPositions}`);
  }

  /**
   * Ejecuta un ciclo de la estrategia (tick).
   * @param allPrices Opcional. Mapa de cotizaciones ya obtenidas para optimizar el peso de API.
   */
  async tick(allPrices?: Record<string, number>): Promise<void> {
    // 1. Obtener precios en masa si no se proveen (peso = 2)
    let prices = allPrices;
    if (!prices || Object.keys(prices).length === 0) {
      prices = await this.client.getAllTickerPrices();
    }

    if (!prices || Object.keys(prices).length === 0) {
      log.warn('No se recibieron cotizaciones de Binance en este tick. Omitiendo ciclo.');
      return;
    }

    // 1.2 Reporte de balances y equity en caliente
    await this.logEquitySummary(prices);

    // 2. Contar posiciones activas locales actuales
    let activePositionsCount = 0;
    for (const symbol of this.config.symbols) {
      const state = this.states[symbol.toUpperCase()];
      if (state && (state.positionQty > 0 || state.buyState === 'IN_POSITION' || state.buyState === 'LIQUIDATING')) {
        activePositionsCount++;
      }
    }

    if (activePositionsCount >= this.config.maxConcurrentPositions) {
      log.warn(`[AGARTHA] Límite de posiciones concurrentes ALCANZADO (${activePositionsCount}/${this.config.maxConcurrentPositions}). Nuevas entradas bloqueadas.`);
    } else {
      log.info(`[AGARTHA] Estado de posiciones: ${activePositionsCount} activas de ${this.config.maxConcurrentPositions} permitidas.`);
    }

    // 3. Procesar cada símbolo de forma aislada con manejo de excepciones robusto
    for (const symbol of this.config.symbols) {
      const symbolUpper = symbol.toUpperCase();
      const marketSymbol = `${symbolUpper}USDT`;
      
      try {
        // 0. Validación de Lista Negra
        if (this.isBlacklisted(symbolUpper)) {
          log.warn(`🚨 [AGARTHA] Operación bloqueada: El símbolo ${symbolUpper} está en la lista negra (anti-scam).`);
          continue;
        }

        const filter = this.filters[marketSymbol];
        if (!filter) {
          log.error(`No hay filtros disponibles para ${marketSymbol}. Omitiendo.`);
          continue;
        }

        if (filter.status !== 'TRADING') {
          log.warn(`El símbolo ${marketSymbol} no está activo para trading (Status actual: ${filter.status}). Omitiendo.`);
          continue;
        }

        // Obtener cotización localmente del mapa masivo
        const currentPrice = prices[marketSymbol];
        if (!currentPrice || currentPrice <= 0) {
          log.warn(`No se encontró cotización en el feed masivo para ${marketSymbol}. Omitiendo.`);
          continue;
        }

        // Inicializar estado del símbolo si no existe
        if (!this.states[symbolUpper]) {
          this.states[symbolUpper] = {
            symbol: symbolUpper,
            positionQty: 0,
            entryPrice: 0,
            peakPrice: 0,
            isTrailingActive: false,
            minPriceSinceTracking: currentPrice,
            buyState: 'WAITING_FOR_TRIGGER',
            ledgersInPosition: 0
          };
        }

        const state = this.states[symbolUpper];

        // ─── LÓGICA DE ESTRATEGIA INDIVIDUAL ───
        if (state.buyState === 'WAITING_FOR_TRIGGER') {
          // Si ya se alcanzó el límite de posiciones, no evaluar entradas ni logs de rastreo para este par
          if (activePositionsCount >= this.config.maxConcurrentPositions) {
            continue;
          }

          // Actualizar mínimo histórico de rastreo
          if (currentPrice < state.minPriceSinceTracking) {
            state.minPriceSinceTracking = currentPrice;
            this.saveState();
          }

          const reboundPct = ((currentPrice - state.minPriceSinceTracking) / state.minPriceSinceTracking) * 100;
          log.info(`[${marketSymbol}] Rastreo Entrada: Precio=$${currentPrice.toFixed(4)} | Mínimo=$${state.minPriceSinceTracking.toFixed(4)} | Rebote=${reboundPct.toFixed(2)}% (Target >= ${this.config.trailingEntryPct}%)`);

          if (reboundPct >= this.config.trailingEntryPct) {
            log.warn(`📈 ¡Disparador de entrada gatillado para ${marketSymbol}! Rebote: ${reboundPct.toFixed(2)}% >= ${this.config.trailingEntryPct}%`);
            await this.executeEntryBuy(symbolUpper, currentPrice, filter);
            // Incrementar contador local para evitar sobre-comprar en el mismo tick
            activePositionsCount++;
          }

        } else if (state.buyState === 'IN_POSITION') {
          state.ledgersInPosition++;
          
          // Evaluar Time Stop
          const elapsedMinutes = state.entryTimestamp ? (Date.now() - state.entryTimestamp) / 60000 : 0;
          if (this.config.maxHoldingMinutes > 0 && elapsedMinutes >= this.config.maxHoldingMinutes) {
            log.warn(`🚨 Time Stop alcanzado para ${marketSymbol} (${elapsedMinutes.toFixed(1)} minutos retenido). Iniciando liquidación...`);
            await this.executeExitSell(symbolUpper, currentPrice, 'TIME_STOP');
            continue;
          }

          // Actualizar pico de precio
          if (currentPrice > state.peakPrice) {
            state.peakPrice = currentPrice;
            this.saveState();
          }

          // Evaluar activación de Trailing Stop
          const profitThreshold = state.entryPrice * (1 + this.config.activationProfitPct / 100);
          if (!state.isTrailingActive && state.peakPrice >= profitThreshold) {
            state.isTrailingActive = true;
            log.warn(`🔔 ¡Trailing Stop ACTIVADO para ${marketSymbol}! PeakPrice($${state.peakPrice.toFixed(4)}) >= Target($${profitThreshold.toFixed(4)})`);
            this.saveState();
          }

          if (state.isTrailingActive) {
            const trailingFloor = state.peakPrice * (1 - this.config.trailingExitPct / 100);
            const dropFromPeakPct = ((state.peakPrice - currentPrice) / state.peakPrice) * 100;
            const totalProfitPct = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
            
            log.info(`[${marketSymbol}] Trailing Stop: Entrada=$${state.entryPrice.toFixed(4)} | Peak=$${state.peakPrice.toFixed(4)} | Piso=$${trailingFloor.toFixed(4)} | Caída=${dropFromPeakPct.toFixed(2)}% | Profit=${totalProfitPct.toFixed(2)}%`);

            if (currentPrice <= trailingFloor) {
              log.warn(`📉 Trailing Stop gatillado para ${marketSymbol}. Ejecutando venta...`);
              await this.executeExitSell(symbolUpper, currentPrice, 'TRAILING_STOP');
            }
          } else {
            log.info(`[${marketSymbol}] En posición: Entrada=$${state.entryPrice.toFixed(4)} | Pico=$${state.peakPrice.toFixed(4)} | TargetAct=$${profitThreshold.toFixed(4)}`);
          }
        }
      } catch (err: any) {
        log.error(`❌ Error al procesar símbolo ${marketSymbol} en este tick:`, err.message || err);
      }
    }
  }

  private async logEquitySummary(prices: Record<string, number>): Promise<void> {
    const now = Date.now();
    // Limitar logs de balance y equity a una vez cada 60 segundos para evitar spam
    if (now - this.lastEquityLogTimestamp < 60000) {
      return;
    }
    this.lastEquityLogTimestamp = now;

    try {
      const balances = await this.client.getBalances();
      const freeUsdt = balances['USDT'] || 0;
      let totalPositionValueUsdt = 0;
      const activePositionsInfo: string[] = [];

      for (const symbol of this.config.symbols) {
        const symbolUpper = symbol.toUpperCase();
        const marketSymbol = `${symbolUpper}USDT`;
        const state = this.states[symbolUpper];

        if (state && state.positionQty > 0) {
          const price = prices[marketSymbol] || state.entryPrice;
          const value = state.positionQty * price;
          totalPositionValueUsdt += value;
          const pnlPct = ((price - state.entryPrice) / state.entryPrice) * 100;
          activePositionsInfo.push(`${symbolUpper}: ${state.positionQty.toFixed(4)} (~${value.toFixed(2)} USDT, PnL: ${pnlPct.toFixed(2)}%)`);
        }
      }

      const totalEquity = freeUsdt + totalPositionValueUsdt;
      
      log.warn(`=====================================================================`);
      log.warn(`💰 REPORTE DE SALDOS Y EQUITY GENERAL (HELENA × SHANGHAI)`);
      log.warn(`   • Equity Total (Valor de Cuenta): $${totalEquity.toFixed(2)} USDT`);
      log.warn(`   • Saldo USDT Disponible (Libre):  $${freeUsdt.toFixed(2)} USDT`);
      log.warn(`   • Valor en Activos (Posición):     $${totalPositionValueUsdt.toFixed(2)} USDT`);
      if (activePositionsInfo.length > 0) {
        log.info(`   • Detalle de Posiciones Activas:`);
        for (const posInfo of activePositionsInfo) {
          log.info(`     - ${posInfo}`);
        }
      } else {
        log.info(`   • Sin posiciones activas.`);
      }
      log.warn(`=====================================================================`);
    } catch (err: any) {
      log.error('Error al generar el reporte de Equity:', err.message || err);
    }
  }

  private async executeEntryBuy(symbol: string, currentPrice: number, filter: BinanceSymbolFilter) {
    const marketSymbol = `${symbol}USDT`;
    const state = this.states[symbol];

    // Verificar liquidez de USDT en tiempo real antes de comprar
    try {
      const balances = await this.client.getBalances();
      const freeUsdt = balances['USDT'] || 0;
      if (freeUsdt < this.config.notionalUsdt) {
        log.error(`[${marketSymbol}] Compra cancelada: Saldo de USDT insuficiente (${freeUsdt.toFixed(2)} USDT < ${this.config.notionalUsdt} USDT).`);
        state.minPriceSinceTracking = currentPrice;
        this.saveState();
        return;
      }
    } catch (balErr: any) {
      log.error(`[${marketSymbol}] Error al verificar balances de saldo antes de comprar:`, balErr.message || balErr);
    }

    // 1. Calcular cantidad basada en volumen nocional (10 USDT)
    const rawQty = this.config.notionalUsdt / currentPrice;
    
    // 2. Ajustar al stepSize
    const qtyPrecision = Math.max(0, Math.round(-Math.log10(filter.stepSize)));
    const targetQty = Math.floor(rawQty / filter.stepSize) * filter.stepSize;
    const formattedQty = targetQty.toFixed(qtyPrecision);

    // 3. Validar filtros
    const finalNotional = targetQty * currentPrice;
    if (finalNotional < filter.minNotional) {
      log.error(`[${marketSymbol}] Compra cancelada: Nocional final ($${finalNotional.toFixed(2)} USDT) es inferior al mínimo permitido por el exchange ($${filter.minNotional} USDT).`);
      state.minPriceSinceTracking = currentPrice;
      this.saveState();
      return;
    }

    log.warn(`[${marketSymbol}] Colocando compra a mercado por ${formattedQty} ${symbol} (~${finalNotional.toFixed(2)} USDT)...`);
    
    state.buyState = 'LIQUIDATING'; // Bloquear re-entradas durante la ejecución de red
    
    try {
      const buyResult = await this.client.executeOrder(marketSymbol, 'BUY', 'MARKET', formattedQty);

      if (buyResult.success) {
        state.positionQty = buyResult.filledQty;
        state.entryPrice = buyResult.filledPrice;
        state.peakPrice = buyResult.filledPrice;
        state.isTrailingActive = false;
        state.buyState = 'IN_POSITION';
        state.ledgersInPosition = 0;
        state.entryTimestamp = Date.now();
        
        log.warn(`✅ [${marketSymbol}] COMPRA EJECUTADA: Qty=${buyResult.filledQty} | Price=$${buyResult.filledPrice.toFixed(4)} | Cost=${(buyResult.filledQty * buyResult.filledPrice).toFixed(2)} USDT`);
        
        db.logTransaction('AGARTHA_BINANCE_BUY', buyResult.orderId, 'FILLED', {
          symbol: symbol,
          price: buyResult.filledPrice,
          qty: buyResult.filledQty,
          cost: buyResult.filledQty * buyResult.filledPrice
        });
      } else {
        log.error(`❌ [${marketSymbol}] Falló la orden de compra en Binance Spot: ${buyResult.error}`);
        state.buyState = 'WAITING_FOR_TRIGGER';
        state.minPriceSinceTracking = currentPrice; // Restablecer
      }
    } catch (err: any) {
      log.error(`❌ Excepción al comprar ${marketSymbol}:`, err.message || err);
      state.buyState = 'WAITING_FOR_TRIGGER';
      state.minPriceSinceTracking = currentPrice;
    }
    
    this.saveState();
  }

  private async executeExitSell(symbol: string, currentPrice: number, reason: string) {
    const marketSymbol = `${symbol}USDT`;
    const state = this.states[symbol];
    const filter = this.filters[marketSymbol];

    if (state.positionQty <= 0) {
      log.error(`[${marketSymbol}] Intento de venta fallido: posición vacía.`);
      this.resetSymbolState(symbol, currentPrice);
      return;
    }

    let targetQty = state.positionQty;

    // Obtener balance real del activo en la cuenta Spot para evitar fallos por comisiones del exchange retenidas (0.1% fee)
    try {
      const balances = await this.client.getBalances();
      const freeAsset = balances[symbol.toUpperCase()] || 0;
      if (freeAsset < targetQty) {
        log.warn(`[${marketSymbol}] Ajustando cantidad de venta por comisiones retenidas del exchange: ${targetQty} -> ${freeAsset}`);
        targetQty = freeAsset;
      }
    } catch (balErr: any) {
      log.error(`[${marketSymbol}] Error consultando balances antes de vender (usando estimación local):`, balErr.message || balErr);
    }

    // Formatear cantidad de salida ajustada a stepSize
    const targetQtyFloored = Math.floor(targetQty / filter.stepSize) * filter.stepSize;
    const qtyPrecision = Math.max(0, Math.round(-Math.log10(filter.stepSize)));
    const formattedQty = targetQtyFloored.toFixed(qtyPrecision);

    // Si la cantidad de venta redondeada baja de las reglas del stepSize, resetear y omitir
    if (parseFloat(formattedQty) <= 0) {
      log.error(`[${marketSymbol}] Cantidad de salida calculada ($${formattedQty}) es inválida para liquidación. Reseteando estado.`);
      this.resetSymbolState(symbol, currentPrice);
      return;
    }

    log.warn(`[${marketSymbol}] Colocando orden de venta a mercado de ${formattedQty} ${symbol} por ${reason}...`);
    
    state.buyState = 'LIQUIDATING';

    try {
      const sellResult = await this.client.executeOrder(marketSymbol, 'SELL', 'MARKET', formattedQty);

      if (sellResult.success) {
        const grossPnl = sellResult.filledQty * (sellResult.filledPrice - state.entryPrice);
        const fee = sellResult.commission; // Binance comisión
        const pnlPct = ((sellResult.filledPrice - state.entryPrice) / state.entryPrice) * 100;
        
        log.warn(`✅ [${marketSymbol}] VENTA EJECUTADA (${reason}): Qty=${sellResult.filledQty} | Price=$${sellResult.filledPrice.toFixed(4)} | PnL=${grossPnl.toFixed(4)} USDT (${pnlPct.toFixed(2)}%)`);
        
        db.logTransaction('AGARTHA_BINANCE_LIQUIDATED', sellResult.orderId, 'FILLED', {
          symbol: symbol,
          reason,
          entryPrice: state.entryPrice,
          exitPrice: sellResult.filledPrice,
          qty: sellResult.filledQty,
          profitUsdt: grossPnl,
          pnlPct: pnlPct
        });
        
        this.resetSymbolState(symbol, sellResult.filledPrice);
      } else {
        log.error(`❌ [${marketSymbol}] Falló la orden de liquidación en Binance Spot: ${sellResult.error}`);
        // Volver a marcar como en posición para reintentar en el próximo tick
        state.buyState = 'IN_POSITION';
      }
    } catch (err: any) {
      log.error(`❌ Excepción al vender ${marketSymbol}:`, err.message || err);
      state.buyState = 'IN_POSITION';
    }
    
    this.saveState();
  }

  private resetSymbolState(symbol: string, currentPrice: number) {
    this.states[symbol] = {
      symbol: symbol,
      positionQty: 0,
      entryPrice: 0,
      peakPrice: 0,
      isTrailingActive: false,
      minPriceSinceTracking: currentPrice,
      buyState: 'WAITING_FOR_TRIGGER',
      ledgersInPosition: 0
    };
  }

  private isBlacklisted(symbol: string): boolean {
    const sym = symbol.toUpperCase();
    return this.blacklist.some(item => sym.includes(item));
  }

  private saveState() {
    db.saveCustomData('binance_agartha_state', this.states);
  }

  private loadState() {
    const saved = db.getCustomData('binance_agartha_state');
    if (saved && typeof saved === 'object') {
      this.states = saved;
      log.info(`Estados restaurados para los símbolos de Agartha Binance: [${Object.keys(this.states).join(', ')}]`);
    }
  }
}
