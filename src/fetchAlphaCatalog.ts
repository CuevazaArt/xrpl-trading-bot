import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('FetchAlphaCatalog');

interface AlphaToken {
  tokenId: string;
  symbol: string;
  name: string;
  chainId: string;
  contractAddress: string;
  price?: string;
  priceChangePercent?: string;
  isCexListed?: boolean;
}

interface BapiResponse {
  code: string;
  message: string;
  data: {
    tokens?: AlphaToken[];
    list?: AlphaToken[];
  } | AlphaToken[] | null;
}

async function fetchAlphaCatalog() {
  log.info('=====================================================================');
  log.info('🌐 SOLICITANDO CATÁLOGO EN VIVO DE MERCADO ALPHA DESDE BINANCE BAPI 🌐');
  log.info('=====================================================================');

  const url = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`Error en respuesta HTTP: Status ${res.status}`);
    }

    const payload = (await res.json()) as BapiResponse;

    if (payload.code !== '000000') {
      throw new Error(`Error retornado por BAPI: ${payload.message} (Código: ${payload.code})`);
    }

    // Extraer tokens
    let tokens: AlphaToken[] = [];
    if (Array.isArray(payload.data)) {
      tokens = payload.data;
    } else if (payload.data && typeof payload.data === 'object') {
      tokens = payload.data.tokens || payload.data.list || [];
    }

    if (tokens.length === 0) {
      log.warn('⚠️ No se encontraron tokens en la respuesta del catálogo de Binance Alpha.');
      return;
    }

    log.info(`✅ Catálogo obtenido con éxito. Total tokens Alpha encontrados: ${tokens.length}`);

    // Limpiar y estructurar lista de símbolos discretos (ej. FARM, POND)
    // Los símbolos son discretos, los emparejaremos con USDT localmente al operar
    const alphaSymbols = tokens.map(t => t.symbol.toUpperCase().trim()).filter(Boolean);
    
    // Eliminar duplicados
    const uniqueSymbols = Array.from(new Set(alphaSymbols));

    log.info(`Símbolos Alpha discretos detectados: [${uniqueSymbols.join(', ')}]`);

    // Crear directorio data si no existe
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Guardar catálogo estructurado completo para auditoría
    const catalogPath = path.join(dataDir, 'alpha_catalog_full.json');
    fs.writeFileSync(catalogPath, JSON.stringify(tokens, null, 2), 'utf8');
    log.info(`📝 Catálogo detallado completo guardado en: ${catalogPath}`);

    // Guardar lista simple de símbolos de trabajo
    const symbolsPath = path.join(dataDir, 'alpha_symbols.json');
    fs.writeFileSync(symbolsPath, JSON.stringify(uniqueSymbols, null, 2), 'utf8');
    log.warn(`🎯 Lista de símbolos de trabajo guardada en de forma persistente: ${symbolsPath}`);

    console.log('\n=====================================================================');
    console.log(`🎉 ¡ÉXITO! Se capturaron ${uniqueSymbols.length} símbolos para operar en Agartha.`);
    console.log(`   Símbolos guardados en: ${symbolsPath}`);
    console.log('=====================================================================');

  } catch (error: any) {
    log.error('❌ Error al solicitar el catálogo de tokens Alpha de Binance:', error.message || error);
    
    // Fallback: Si falla la BAPI, crear lista por defecto para no romper el flujo
    const fallbackSymbols = ['FARM', 'POND', 'BOB', 'TA'];
    const symbolsPath = path.join(process.cwd(), 'data', 'alpha_symbols.json');
    fs.writeFileSync(symbolsPath, JSON.stringify(fallbackSymbols, null, 2), 'utf8');
    log.warn(`⚠️ Se escribió una lista de símbolos Alpha de respaldo (Fallback) en: ${symbolsPath}`);
  }
}

fetchAlphaCatalog().catch(err => {
  log.error('Excepción global en fetchAlphaCatalog:', err);
});
