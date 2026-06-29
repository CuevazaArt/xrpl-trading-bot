import dotenv from 'dotenv';
import path from 'path';
import { Logger, LogLevel, createLogger } from './logger.js';

// Cargar variables de entorno
dotenv.config();

function parseEnvConfig() {
  return {
    xrplWsUrl: process.env.XRPL_WS_URL || 'wss://s.altnet.rippletest.net:51233',
    walletSeed: process.env.XRPL_WALLET_SEED || null,
    strategy: process.env.STRATEGY || 'market_maker',
    
    // Emisor USD (Bitstamp) — centralizado para todo el bot
    usdIssuer: process.env.USD_ISSUER || 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
    
    // Binance CEX (para arbitraje de 2 patas)
    binanceApiKey: process.env.BINANCE_API_KEY || '',
    binanceApiSecret: process.env.BINANCE_API_SECRET || '',
    binanceBaseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
    
    // Parámetros de Dorothy (DCA Long)
    dorothyProfitFactor: parseFloat(process.env.DOROTHY_PROFIT_FACTOR || '0.05'),
    dorothyMarginDropFactor: parseFloat(process.env.DOROTHY_MARGIN_DROP_FACTOR || '0.03'),
    
    // Parámetros de Elphaba (DCA Short en Spot)
    elphabaProfitFactor: parseFloat(process.env.ELPHABA_PROFIT_FACTOR || '0.05'),
    elphabaMarginRiseFactor: parseFloat(process.env.ELPHABA_MARGIN_RISE_FACTOR || '0.03'),
    
    // Parámetros de Louise
    louiseProfitTargetPct: parseFloat(process.env.LOUISE_PROFIT_TARGET_PCT || '5.0'),
    louiseDcaStepPct: parseFloat(process.env.LOUISE_DCA_STEP_PCT || '3.0'),

    // Parámetros de Anti-Louise
    antiLouiseProfitTargetPct: parseFloat(process.env.ANTI_LOUISE_PROFIT_TARGET_PCT || '5.0'),
    antiLouiseDcaStepPct: parseFloat(process.env.ANTI_LOUISE_DCA_STEP_PCT || '3.0'),

    // Parámetros de Masha (DCA Accumulator HODL)
    mashaDcaStepPct: parseFloat(process.env.MASHA_DCA_STEP_PCT || '2.0'),
    mashaBuyQtyXrp: parseFloat(process.env.MASHA_BUY_QTY_XRP || '10'),

    // Parámetros de Thusnelda
    thusneldaSymbolsCsv: process.env.THUSNELDA_SYMBOLS_CSV || 'XRP,ADA,DOT',
    thusneldaFactorMult: parseFloat(process.env.THUSNELDA_FACTOR_MULT || '0.97'),
    thusneldaMetaEquityUsdt: parseFloat(process.env.THUSNELDA_META_EQUITY_USDT || '100.0'),
    thusneldaMaxDrawdownPct: parseFloat(process.env.THUSNELDA_MAX_DRAWDOWN_PCT || '15.0'),
    thusneldaQuoteQty: parseFloat(process.env.THUSNELDA_QUOTE_QTY || '10.0'),

    // Parámetros de Agartha (Volatile Asset Moonshot)
    agarthaTrailingStopPct: parseFloat(process.env.AGARTHA_TRAILING_STOP_PCT || '15.0'),
    agarthaActivationProfitPct: parseFloat(process.env.AGARTHA_ACTIVATION_PROFIT_PCT || '10.0'),
    agarthaEntryLimitOffsetPct: parseFloat(process.env.AGARTHA_ENTRY_LIMIT_OFFSET_PCT || '2.0'),
    agarthaMaxHoldingLedgers: parseInt(process.env.AGARTHA_MAX_HOLDING_LEDGERS || '1000', 10),
    agarthaBudgetUsd: parseFloat(process.env.AGARTHA_BUDGET_USD || '100.0'),
    agarthaBuyQty: parseFloat(process.env.AGARTHA_BUY_QTY || '10.0'),
    agarthaAssetCode: process.env.AGARTHA_ASSET_CODE || 'FARM',
    agarthaAssetIssuer: process.env.AGARTHA_ASSET_ISSUER || 'rMoZZVnQCdQfKMvrHmYfRW9iuwM3LTKfV6',
    agarthaCexOracle: process.env.AGARTHA_CEX_ORACLE || 'FARMUSDT',

    // Parámetros comunes de DCA
    maxRungs: parseInt(process.env.MAX_RUNGS || '3', 10),
    rungQtyXrp: process.env.RUNG_QTY_XRP || '10',

    // Parámetros de Arbitraje DEX-CEX
    arbMinSpreadPct: parseFloat(process.env.ARB_MIN_SPREAD_PCT || '0.15'),
    arbMaxTradeXrp: parseFloat(process.env.ARB_MAX_TRADE_XRP || '50'),
    arbMinTradeXrp: parseFloat(process.env.ARB_MIN_TRADE_XRP || '10'),
    arbMaxPositionXrp: parseFloat(process.env.ARB_MAX_POSITION_XRP || '200'),
    arbCooldownLedgers: parseInt(process.env.ARB_COOLDOWN_LEDGERS || '2', 10),
    arbMaxSlippagePct: parseFloat(process.env.ARB_MAX_SLIPPAGE_PCT || '0.10'),
    arbMinOracleConfidence: parseFloat(process.env.ARB_MIN_ORACLE_CONFIDENCE || '0.6'),
    arbMinOracleSources: parseInt(process.env.ARB_MIN_ORACLE_SOURCES || '2', 10),

    // Market Maker
    mmBaseSpread: parseFloat(process.env.MM_BASE_SPREAD || '0.01'),
    mmMinSpread: parseFloat(process.env.MM_MIN_SPREAD || '0.005'),
    mmMaxSpread: parseFloat(process.env.MM_MAX_SPREAD || '0.02'),
    mmOrderAmountXrp: parseFloat(process.env.MM_ORDER_AMOUNT_XRP || '10'),
    mmPriceDeviationThreshold: parseFloat(process.env.MM_PRICE_DEVIATION_THRESHOLD || '0.003'),
    mmCooldownLedgers: parseInt(process.env.MM_COOLDOWN_LEDGERS || '3', 10),
    mmMaxPositionXrp: parseFloat(process.env.MM_MAX_POSITION_XRP || '80'),
    mmTargetPositionXrp: parseFloat(process.env.MM_TARGET_POSITION_XRP || '50'),
    mmMinProfitMargin: parseFloat(process.env.MM_MIN_PROFIT_MARGIN || '1.5'),

    // Carousel Mode — duraciones de ventana (ledgers)
    mmCarouselTightLedgers: parseInt(process.env.MM_CAROUSEL_TIGHT_LEDGERS || '10', 10),
    mmCarouselStandardLedgers: parseInt(process.env.MM_CAROUSEL_STANDARD_LEDGERS || '10', 10),
    mmCarouselIocLedgers: parseInt(process.env.MM_CAROUSEL_IOC_LEDGERS || '5', 10),
    mmCarouselRestLedgers: parseInt(process.env.MM_CAROUSEL_REST_LEDGERS || '5', 10),
    mmCarouselRestMaxLedgers: parseInt(process.env.MM_CAROUSEL_REST_MAX_LEDGERS || '20', 10),
    // Tight Passive spread override
    mmTightSpread: parseFloat(process.env.MM_TIGHT_SPREAD || '0.003'),
    // IOC: ventaja mínima DEX vs Oracle para cruzar (0.5% = evita falsos edges en testnet)
    mmIocMinDexEdge: parseFloat(process.env.MM_IOC_MIN_DEX_EDGE || '0.005'),

    // Telegram Notifier
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

    // Health Monitor
    healthIntervalSeconds: parseInt(process.env.HEALTH_INTERVAL_SECONDS || '300', 10),

    // Dashboard
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    dashboardToken: process.env.DASHBOARD_TOKEN || '',

    // Desactivación de oráculos individuales
    disableCryptoCompare: process.env.DISABLE_CRYPTOCOMPARE === 'true' || !process.env.CRYPTOCOMPARE_API_KEY,
    disableBinanceOracle: process.env.DISABLE_BINANCE === 'true',
    disableKrakenOracle: process.env.DISABLE_KRAKEN === 'true',
    disableCoinbaseOracle: process.env.DISABLE_COINBASE === 'true',

    // Log level (DEBUG, INFO, WARN, ERROR)
    logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),

    // Parámetros de Mitigación de Pérdidas y Costos
    haltOnOracleFailure: process.env.HALT_ON_ORACLE_FAILURE !== 'false',
    oracleMaxAgeSeconds: parseInt(process.env.ORACLE_MAX_AGE_SECONDS || '60', 10),
    maxFeeDrops: parseInt(process.env.MAX_FEE_DROPS || '50000', 10),
    minXrpReserveBuffer: parseFloat(process.env.MIN_XRP_RESERVE_BUFFER || '10.0'),
    walletProvider: (process.env.WALLET_PROVIDER || 'eoa').toLowerCase(),

    // Production Safety — Stop Loss & Circuit Breaker
    mmMaxSessionFeeDrops: parseInt(process.env.MM_MAX_SESSION_FEE_DROPS || '50000', 10),
    mmMaxLossUsd: parseFloat(process.env.MM_MAX_LOSS_USD || '5.0'),
  };
}

export const config = parseEnvConfig();

export function reloadConfig(): void {
  // Volver a cargar el archivo .env
  dotenv.config({ override: true });
  const fresh = parseEnvConfig();
  Object.assign(config, fresh);

  // Configurar nivel de log global
  const levelMap: Record<string, LogLevel> = {
    'DEBUG': LogLevel.DEBUG,
    'INFO': LogLevel.INFO,
    'WARN': LogLevel.WARN,
    'ERROR': LogLevel.ERROR,
  };
  Logger.setLevel(levelMap[config.logLevel] ?? LogLevel.DEBUG);
  
  const log = createLogger('Config');
  log.info('Configuración recargada exitosamente en caliente desde el archivo .env.');
}

// Validación básica
if (!config.xrplWsUrl) {
  const log = createLogger('Config');
  log.warn("XRPL_WS_URL no está definido en el archivo .env. Usando Testnet por defecto.");
}

