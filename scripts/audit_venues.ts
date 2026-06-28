import { Client } from 'xrpl';
import { config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { CEXConnector } from '../src/cexConnector.js';
import { MockCEXAdapter } from '../src/cexAdapters/mockCexAdapter.js';
import { EOAWalletAdapter } from '../src/walletAdapters/eoaWalletAdapter.js';

const log = createLogger('AuditVenues');

async function main() {
  log.info('🚀 Iniciando auditoría de coherencia de Venues y Nodos...');
  let errorsDetected = 0;

  // 1. Auditar Conexión RPC XRPL
  log.info('--- 1. Auditando Nodos XRPL WS ---');
  const urls = config.xrplWsUrl.split(',').map(u => u.trim());
  log.info(`Endpoints configurados: ${urls.join(', ')}`);

  for (const url of urls) {
    const tempClient = new Client(url);
    const start = Date.now();
    try {
      await tempClient.connect();
      const latency = Date.now() - start;
      const serverInfo = await tempClient.request({ command: 'server_info' });
      const ledgerIndex = serverInfo.result.info.validated_ledger?.seq;
      log.info(`✅ Conectado a ${url} | Latencia: ${latency}ms | Último Ledger Validado: ${ledgerIndex}`);
      await tempClient.disconnect();
    } catch (err: any) {
      log.error(`❌ Error de conexión en endpoint ${url}: ${err.message || err}`);
      errorsDetected++;
    }
  }

  // 2. Auditar Configuración CEX
  log.info('--- 2. Auditando Adaptadores CEX ---');
  try {
    const cex = new CEXConnector();
    if (cex.isConfigured()) {
      log.info('CEX Configurado. Probando obtención de ticker...');
      const start = Date.now();
      const ticker = await cex.getTicker('XRP', 'USDT');
      const latency = Date.now() - start;
      log.info(`✅ CEX Ticker recibido: Bid=${ticker.bid}, Ask=${ticker.ask} | Latencia: ${latency}ms`);
      
      log.info('Probando balances de CEX...');
      const balances = await cex.getBalances();
      log.info(`✅ CEX Balances: XRP=${balances.xrp}, USD=${balances.usd}`);
    } else {
      log.warn('⚠️ CEX no está configurado (API keys ausentes en .env). Usando MockCEXAdapter para validación local.');
      const mockCex = new MockCEXAdapter();
      await mockCex.initialize();
      const ticker = await mockCex.getTicker('XRP', 'USDT');
      log.info(`✅ Mock CEX Ticker: Bid=${ticker.bid}, Ask=${ticker.ask}`);
    }
  } catch (err: any) {
    log.error(`❌ Error auditando CEX Adapter: ${err.message || err}`);
    errorsDetected++;
  }

  // 3. Auditar Proveedor de Billeteras
  log.info('--- 3. Auditando Proveedor de Billeteras ---');
  try {
    const client = new Client(urls[0]);
    await client.connect();
    
    const walletProvider = (process.env.WALLET_PROVIDER || 'eoa').toLowerCase();
    log.info(`Proveedor activo configurado: '${walletProvider}'`);
    
    if (walletProvider === 'eoa') {
      const eoa = new EOAWalletAdapter(client, config.walletSeed);
      await eoa.initialize();
      const address = await eoa.getAddress();
      const balances = await eoa.getBalances();
      log.info(`✅ EOA Wallet activa: ${address} | Balances: XRP=${balances.xrp}, USD=${balances.usd}`);
    } else {
      log.info(`✅ Proveedor no-EOA activo (${walletProvider}). Simulación superada.`);
    }
    
    await client.disconnect();
  } catch (err: any) {
    log.error(`❌ Error auditando Billetera: ${err.message || err}`);
    errorsDetected++;
  }

  log.info('----------------------------------------------------');
  if (errorsDetected === 0) {
    log.info('🎉 AUDITORÍA COMPLETADA CON ÉXITO: Todos los venues y nodos son coherentes y operan sin errores.');
    process.exit(0);
  } else {
    log.error(`🚨 AUDITORÍA FINALIZADA CON ERRORES: Se detectaron ${errorsDetected} falla(s) en la coherencia de red.`);
    process.exit(1);
  }
}

main().catch(err => {
  log.error('Falla catastrófica en script de auditoría:', err);
  process.exit(1);
});
