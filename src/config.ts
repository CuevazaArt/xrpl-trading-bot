import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno
dotenv.config();

export const config = {
  xrplWsUrl: process.env.XRPL_WS_URL || 'wss://s.altnet.rippletest.net:51233',
  walletSeed: process.env.XRPL_WALLET_SEED || null,
  strategy: process.env.STRATEGY || 'market_maker',
  
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

  // Parámetros de Masha
  mashaProfitFactor: parseFloat(process.env.MASHA_PROFIT_FACTOR || '2.0'),
  mashaMaPeriods1w: parseInt(process.env.MASHA_MA_PERIODS_1W || '20', 10),
  mashaMaPeriods1h: parseInt(process.env.MASHA_MA_PERIODS_1H || '20', 10),
  mashaMarginLow1w: parseFloat(process.env.MASHA_MARGIN_LOW_1W || '2.0'),
  mashaMarginLow1h: parseFloat(process.env.MASHA_MARGIN_LOW_1H || '1.0'),
  mashaBuyQtyBase: parseFloat(process.env.MASHA_BUY_QTY_BASE || '10'),

  // Parámetros de Thusnelda
  thusneldaSymbolsCsv: process.env.THUSNELDA_SYMBOLS_CSV || 'XRP,ADA,DOT',
  thusneldaFactorMult: parseFloat(process.env.THUSNELDA_FACTOR_MULT || '0.97'),
  thusneldaMetaEquityUsdt: parseFloat(process.env.THUSNELDA_META_EQUITY_USDT || '100.0'),
  thusneldaMaxDrawdownPct: parseFloat(process.env.THUSNELDA_MAX_DRAWDOWN_PCT || '15.0'),
  thusneldaQuoteQty: parseFloat(process.env.THUSNELDA_QUOTE_QTY || '10.0'),

  // Parámetros de Agartha
  agarthaTrailingStopPct: parseFloat(process.env.AGARTHA_TRAILING_STOP_PCT || '15.0'),
  agarthaActivationProfitPct: parseFloat(process.env.AGARTHA_ACTIVATION_PROFIT_PCT || '10.0'),
  agarthaEntryLimitOffsetPct: parseFloat(process.env.AGARTHA_ENTRY_LIMIT_OFFSET_PCT || '2.0'),
  agarthaMaxHoldingLedgers: parseInt(process.env.AGARTHA_MAX_HOLDING_LEDGERS || '1000', 10),

  // Parámetros comunes de DCA
  maxRungs: parseInt(process.env.MAX_RUNGS || '3', 10),
  rungQtyXrp: process.env.RUNG_QTY_XRP || '10',
};

// Validación básica
if (!config.xrplWsUrl) {
  console.warn("ADVERTENCIA: XRPL_WS_URL no está definido en el archivo .env. Usando Testnet por defecto.");
}

