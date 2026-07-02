import { BinanceSpotClient } from './cexAdapters/binanceSpotClient.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function main() {
  console.log('=====================================================================');
  console.log('🔍 AUDITORÍA PRE-EJECUCIÓN DE CUENTA DE BINANCE DEDICADA 🔍');
  console.log('=====================================================================');

  const client = new BinanceSpotClient();
  if (!client.isConfigured()) {
    console.error('❌ ERROR: Las API Keys de Binance no están configuradas en el archivo .env.');
    process.exit(1);
  }

  // 1. Consultar Balances
  console.log('\n💼 1. CONSULTANDO BALANCES EN LA CUENTA...');
  const balances = await client.getBalances();
  const balanceKeys = Object.keys(balances);
  if (balanceKeys.length === 0) {
    console.log('   ⚠️ No se detectaron balances con saldo libre positivo o falló la llamada.');
  } else {
    for (const asset of balanceKeys) {
      console.log(`   - ${asset}: ${balances[asset].toFixed(6)}`);
    }
  }

  const usdtBalance = balances['USDT'] || 0;
  console.log(`   👉 Balance USDT Disponible: ${usdtBalance.toFixed(2)} USDT`);

  // 2. Consultar Órdenes Pendientes
  console.log('\n⏳ 2. CONSULTANDO ÓRDENES PENDIENTES (ABIERTAS)...');
  const openOrders = await client.getOpenOrders();
  if (openOrders.length === 0) {
    console.log('   ✅ No hay órdenes abiertas pendientes en Binance Spot.');
  } else {
    console.log(`   ⚠️ Se encontraron ${openOrders.length} órdenes abiertas:`);
    for (const order of openOrders) {
      console.log(`   - [${order.symbol}] ID: ${order.orderId} | ${order.side} ${order.type} | Qty: ${order.origQty} | Price: ${order.price}`);
    }
  }

  // 3. Consultar Catálogo Alpha y Cotizaciones
  console.log('\n📊 3. AUDITORÍA DEL CATÁLOGO DE MERCADO ALPHA...');
  let symbols: string[] = [];
  const symbolsPath = path.join(process.cwd(), 'data', 'alpha_symbols.json');
  if (fs.existsSync(symbolsPath)) {
    try {
      const content = fs.readFileSync(symbolsPath, 'utf8');
      symbols = JSON.parse(content);
      console.log(`   ✅ Símbolos Alpha detectados del catálogo en vivo: [${symbols.join(', ')}]`);
    } catch (err: any) {
      console.log(`   ⚠️ No se pudo leer ${symbolsPath}, usando fallback.`);
    }
  }

  if (symbols.length === 0) {
    const symbolsCsv = process.env.AGARTHA_BINANCE_SYMBOLS || 'FARM,POND,BOB,TA';
    symbols = symbolsCsv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    console.log(`   ⚠️ Símbolos configurados (fallback): [${symbols.join(', ')}]`);
  }

  if (symbols.length === 0) {
    console.error('   ❌ Error: No hay símbolos de trabajo cargados.');
  } else {
    // Obtener filtros de todos los símbolos de Binance Spot (evita error HTTP 400 y URL larga)
    const allFilters = await client.getExchangeInfo();
    // Obtener cotizaciones masivas
    const prices = await client.getAllTickerPrices();

    let totalRequiredCapital = 0;
    const notional = parseFloat(process.env.AGARTHA_BINANCE_NOTIONAL || '10.0');
    let validPairsCount = 0;

    for (const symbol of symbols) {
      const pair = `${symbol}USDT`;
      const filter = allFilters[pair];
      const price = prices[pair] || 0;

      if (!filter) {
        // Omitir tokens del catálogo de Web3/DeFi que aún no cotizan en Binance CEX Spot
        continue;
      }

      const statusIcon = filter.status === 'TRADING' ? '✅' : '🚨';
      console.log(`   - ${statusIcon} ${pair}: Precio=$${price > 0 ? price.toFixed(4) : 'N/A'} | Status=${filter.status} | minNotional=${filter.minNotional} USDT | stepSize=${filter.stepSize}`);
      
      if (filter.status === 'TRADING') {
        totalRequiredCapital += notional;
        validPairsCount++;
      }
    }

    // 4. Análisis de Capital Mínimo
    const recommendedCapital = totalRequiredCapital * 1.05;
    console.log('\n💸 4. ANÁLISIS DE CAPITAL MÍNIMO REQUERIDO:');
    console.log(`   - Cantidad de activos Alpha cotizando en Spot: ${validPairsCount}`);
    console.log(`   - Volumen nocional por posición: ${notional} USDT`);
    console.log(`   - Capital máximo expuesto de forma simultánea: ${totalRequiredCapital} USDT`);
    console.log(`   - Capital mínimo recomendado (con 5% buffer): ${recommendedCapital.toFixed(2)} USDT`);
    console.log(`   - Balance USDT actual en la cuenta Spot: ${usdtBalance.toFixed(2)} USDT`);
    
    if (usdtBalance >= recommendedCapital) {
      console.log('   ✅ RENTABILIDAD Y LIQUIDEZ: Tienes fondos suficientes para cubrir el peor escenario.');
    } else if (usdtBalance >= notional) {
      console.log(`   ⚠️ ALERTA: Tienes fondos para operar posiciones individuales (${usdtBalance.toFixed(2)} USDT), pero si se abren todas simultáneamente (${totalRequiredCapital} USDT) te quedarás sin liquidez.`);
    } else {
      console.log('   🚨 ERROR DE FONDOS: Tu balance actual es inferior al nocional mínimo de una sola posición (10 USDT). El bot no podrá colocar órdenes.');
    }
  }
  console.log('=====================================================================');
}

main().catch(err => {
  console.error('Error durante la ejecución del script de auditoría:', err);
});
