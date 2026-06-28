import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('ConfigValidator');

// =====================================================================
// CONFIG VALIDATOR — Ejecutar al arranque antes de operar
// =====================================================================

interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Valida la configuración del bot antes de arrancar.
 * En mainnet, errores fatales abortan el proceso.
 * En testnet, se emiten warnings pero se permite continuar.
 */
export function validateConfig(config: Record<string, any>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const isMainnet = isMainnetUrl(config.xrplWsUrl);

  // ─── Wallet Provider ───
  const validProviders = ['eoa', 'mock', 'safe'];
  if (!validProviders.includes(config.walletProvider)) {
    errors.push(`WALLET_PROVIDER inválido: "${config.walletProvider}". Valores soportados: ${validProviders.join(', ')}.`);
  }

  // ─── Wallet Seed (Solo requerido para EOA) ───
  if (config.walletProvider === 'eoa' && !config.walletSeed && !vaultFileExists()) {
    errors.push('No hay seed configurado para el proveedor "eoa" (ni XRPL_WALLET_SEED ni vault cifrado).');
  }

  // ─── USD Issuer — validar formato de dirección XRPL ───
  if (config.usdIssuer && !isValidXrplAddress(config.usdIssuer)) {
    errors.push(`USD_ISSUER inválido: "${config.usdIssuer}". Debe ser una dirección XRPL válida (r...).`);
  }

  // ─── Spread Consistency ───
  if (config.mmMinSpread >= config.mmBaseSpread) {
    warnings.push(`MM_MIN_SPREAD (${config.mmMinSpread}) >= MM_BASE_SPREAD (${config.mmBaseSpread}). El spread mínimo debería ser menor que el base.`);
  }
  if (config.mmBaseSpread >= config.mmMaxSpread) {
    warnings.push(`MM_BASE_SPREAD (${config.mmBaseSpread}) >= MM_MAX_SPREAD (${config.mmMaxSpread}). El spread base debería ser menor que el máximo.`);
  }
  if (config.mmMinSpread < 0 || config.mmBaseSpread < 0 || config.mmMaxSpread < 0) {
    errors.push('Los valores de spread no pueden ser negativos.');
  }

  // ─── Order Amount ───
  if (config.mmOrderAmountXrp <= 0) {
    errors.push(`MM_ORDER_AMOUNT_XRP (${config.mmOrderAmountXrp}) debe ser > 0.`);
  }

  // ─── Mainnet-specific checks ───
  if (isMainnet) {
    if (!config.dashboardToken && config.dashboardPort) {
      warnings.push('MAINNET detectada sin DASHBOARD_TOKEN. El dashboard web estará accesible sin autenticación.');
    }

    if (config.walletProvider === 'eoa' && config.walletSeed && !vaultFileExists()) {
      warnings.push('MAINNET detectada con seed en texto plano en .env. Considera usar `npm run vault:encrypt` para cifrar el seed.');
    }

    if (config.maxFeeDrops > 100000) {
      warnings.push(`MAX_FEE_DROPS (${config.maxFeeDrops}) es muy alto para mainnet. Valor recomendado: 12-50000 drops.`);
    }
  }

  // ─── Oracle Config ───
  if (config.oracleMaxAgeSeconds < 10) {
    warnings.push(`ORACLE_MAX_AGE_SECONDS (${config.oracleMaxAgeSeconds}) es muy bajo. Puede causar falsos cortes de trading.`);
  }

  // ─── Reserve Buffer ───
  if (config.minXrpReserveBuffer < 2) {
    warnings.push(`MIN_XRP_RESERVE_BUFFER (${config.minXrpReserveBuffer}) es bajo. Mínimo recomendado: 5 XRP.`);
  }

  // ─── Cooldown ───
  if (config.mmCooldownLedgers < 1) {
    warnings.push(`MM_COOLDOWN_LEDGERS (${config.mmCooldownLedgers}) es 0. Helena colocará órdenes en cada ledger sin descanso.`);
  }

  return { errors, warnings };
}

/**
 * Ejecuta la validación y toma acción según severidad.
 * - Warnings: se loguean pero no detienen el bot.
 * - Errors en mainnet: abortan el proceso.
 * - Errors en testnet: se loguean como warnings (modo permisivo).
 */
export function runConfigValidation(config: Record<string, any>): void {
  const { errors, warnings } = validateConfig(config);
  const isMainnet = isMainnetUrl(config.xrplWsUrl);

  // Emitir warnings
  for (const w of warnings) {
    log.warn(`⚠️  ${w}`);
  }

  // Emitir errores
  if (errors.length > 0) {
    for (const e of errors) {
      log.error(`❌ ${e}`);
    }

    if (isMainnet) {
      log.error(`\n🚫 ${errors.length} error(es) de configuración detectados en MAINNET. Abortando por seguridad.`);
      log.error('Corrige los errores anteriores en .env y reinicia Helena.');
      process.exit(1);
    } else {
      log.warn(`⚠️  ${errors.length} error(es) de configuración detectados en TESTNET. Continuando en modo permisivo.`);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    log.info('✅ Configuración validada correctamente.');
  } else if (errors.length === 0) {
    log.info(`✅ Configuración válida con ${warnings.length} advertencia(s).`);
  }
}

// =====================================================================
// HELPERS
// =====================================================================

function isMainnetUrl(url: string): boolean {
  if (!url) return false;
  // Mainnet URLs no contienen testnet/devnet/altnet/rippletest
  return !url.includes('testnet') &&
         !url.includes('devnet') &&
         !url.includes('altnet') &&
         !url.includes('rippletest') &&
         url.startsWith('wss://');
}

function isValidXrplAddress(address: string): boolean {
  // XRPL addresses start with 'r' and are 25-35 chars of base58
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

function vaultFileExists(): boolean {
  try {
    return fs.existsSync(path.join(process.cwd(), 'data', 'seed.vault'));
  } catch {
    return false;
  }
}
