import { Worker } from 'worker_threads';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Wallet } from 'xrpl';

const RUN_DURATION_MS = 86400000; // 24 horas de test
const children = [];

console.log('🚀 [TEST DE ESTRÉS] Iniciando fase de compilación de TypeScript...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ [TEST DE ESTRÉS] Compilación completa en dist/.');
} catch (buildErr) {
  console.error('❌ [TEST DE ESTRÉS] Error durante la compilación:', buildErr.message);
  process.exit(1);
}

// Cargar dinámicamente el oráculo compilado
const { MultiOracle } = await import('../dist/multiOracle.js');
const oracle = new MultiOracle();

// Asegurar directorio data
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Configurar estrategias e issuers
const STRATEGIES = [
  'market_maker',
  'dorothy',
  'elphaba',
  'louise',
  'anti_louise',
  'masha',
  'thusnelda',
  'agartha',
  'arbitrage'
];

// Generar 12 emisores/gateways XRPL válidos y únicos dinámicamente
console.log('🔑 [TEST DE ESTRÉS] Generando 12 emisores XRPL base58-checksummed...');
const ISSUERS = [];
for (let i = 0; i < 12; i++) {
  ISSUERS.push(Wallet.generate().address);
}

const TOTAL_INSTANCES = 100;
console.log(`🚀 [TEST DE ESTRÉS] Iniciando orquestación de ${TOTAL_INSTANCES} worker_threads con espaciado de 150ms...`);

(async () => {
  for (let i = 0; i < TOTAL_INSTANCES; i++) {
    const strategy = STRATEGIES[i % STRATEGIES.length];
    const issuer = ISSUERS[i % ISSUERS.length];
    const instanceIndex = i;

    // Espaciado dinámico corto (hilos nativos son mucho más rápidos de iniciar que procesos)
    await new Promise(resolve => setTimeout(resolve, 150));

    const logFile = path.join(dataDir, `stress_test_instance_${instanceIndex}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });

    // Rotación de nodos testnet
    const TESTNET_NODES = [
      'wss://s.altnet.rippletest.net:51233',
      'wss://testnet.xrpl-labs.com',
      'wss://clio.altnet.rippletest.net:51233',
      'wss://testnet.honeycluster.io'
    ];
    const rotatedNodes = [];
    for (let k = 0; k < TESTNET_NODES.length; k++) {
      rotatedNodes.push(TESTNET_NODES[(instanceIndex + k) % TESTNET_NODES.length]);
    }
    const nodeUrlsString = rotatedNodes.join(', ');

    const env = {
      STRATEGY: strategy,
      USD_ISSUER: issuer,
      XRPL_WS_URL: nodeUrlsString,
      DASHBOARD_PORT: String(3100 + instanceIndex),
      LOG_LEVEL: 'INFO',
      PAPER_TRADING: 'true',
      SKIP_SWAP: 'true',
      NO_DASHBOARD: 'true'
    };

    // Lanzar worker thread nativo con captura de stdout/stderr
    const worker = new Worker('./dist/index.js', {
      workerData: env,
      stdout: true,
      stderr: true
    });

    worker.stdout.pipe(logStream);
    worker.stderr.pipe(logStream);

    children.push({
      worker,
      strategy,
      issuer,
      index: instanceIndex,
      logFile,
      ticks: 0,
      orders: 0,
      errors: 0,
      balance: 1000.00,
      pnl: '+0.00%',
      lastAction: 'Inicializando...'
    });
  }

  console.log(`✅ [TEST DE ESTRÉS] Hilos iniciados. ${children.length} instancias corriendo en paralelo.`);
  console.log(`ℹ️  Logs individuales de hilos en: data/stress_test_instance_*.log`);
  console.log('📊 Monitoreando ejecución en paralelo. Presione Ctrl+C para detener...\n');
})();

// Bucle de consulta unificado del oráculo (Fase A: Centralización)
setInterval(async () => {
  try {
    const consensus = await oracle.getConsensusPrice();
    if (consensus) {
      for (const child of children) {
        child.worker.postMessage({ type: 'price_update', consensus });
      }
    }
  } catch (err) {
    // Evitar propagar fallos de red del oráculo
  }
}, 2000);

// Bucle del monitor MTMH (cada 5 segundos)
const monitorInterval = setInterval(() => {
  console.clear();
  console.log('=============================================================================================================================================');
  console.log(` 📊 MATRIZ DE TELEMETRÍA MULTIPROCESO HELENA (MTMH) — ${children.length} Instancias Concurrentes (Hilos Nativos)`);
  console.log('=============================================================================================================================================');
  console.log('ID | Estrategia       | Emisor / Gateway  | Ticks | Ord | Err | Saldo Disponible | Retorno P&L | Última Acción Operativa');
  console.log('---|------------------|-------------------|-------|-----|-----|------------------|-------------|----------------------------------------');

  // Mostramos solo un subset resumido en consola para evitar saturar la terminal con 100 líneas
  const visibleSubset = children.slice(0, 30);

  for (const inst of children) {
    try {
      if (fs.existsSync(inst.logFile)) {
        const content = fs.readFileSync(inst.logFile, 'utf8');
        inst.ticks = (content.match(/tick/gi) || []).length;
        inst.orders = (content.match(/Compra exitosa|Venta exitosa|colocada|creada|PAPER_CEX_|Paper BUY|Paper SELL/gi) || []).length;
        inst.errors = (content.match(/error|exception|falló|crítica/gi) || []).length;

        const portfolioMatch = [...content.matchAll(/Portfolio:\s*\$([0-9.]+)\s*\(([^)]+)\)/gi)].pop();
        if (portfolioMatch) {
          inst.balance = parseFloat(portfolioMatch[1]);
          inst.pnl = portfolioMatch[2];
        } else {
          const pnlMatch = [...content.matchAll(/Net P&L:\s*\$([0-9.-]+)\s*\(([^)]+)\)/gi)].pop();
          if (pnlMatch) {
            inst.pnl = pnlMatch[2];
          }
        }

        const actionLines = content.split('\n').filter(line => line.includes('INF') && !line.includes('Watchdog') && !line.includes('LogMonit'));
        const lastActionLine = actionLines.pop() || '';
        if (lastActionLine) {
          const parts = lastActionLine.match(/(?:INF|WRN)\s+\w+\s+(.*)/);
          if (parts && parts[1]) {
            inst.lastAction = parts[1].trim().substring(0, 38);
          } else {
            inst.lastAction = lastActionLine.substring(20, 58).trim();
          }
        }
      }
    } catch {
      // Ignorar bloqueos temporales de lectura
    }
  }

  // Renderizar las primeras 30
  for (const inst of visibleSubset) {
    const idStr = String(inst.index).padStart(2, '0');
    const stratStr = inst.strategy.padEnd(16, ' ');
    const issuerStr = (inst.issuer.substring(0, 6) + '...' + inst.issuer.slice(-8)).padEnd(17, ' ');
    const tickStr = String(inst.ticks).padStart(5, ' ');
    const orderStr = String(inst.orders).padStart(3, ' ');
    const errorStr = String(inst.errors).padStart(3, ' ');
    const balanceStr = `$${inst.balance.toFixed(2)} USDT`.padEnd(16, ' ');
    const pnlStr = inst.pnl.padEnd(11, ' ');
    const actionStr = inst.lastAction.padEnd(38, ' ');

    console.log(`${idStr} | ${stratStr} | ${issuerStr} | ${tickStr} | ${orderStr} | ${errorStr} | ${balanceStr} | ${pnlStr} | ${actionStr}`);
  }

  console.log('=============================================================================================================================================');
  console.log(`... [ Mostrando las primeras 30 de ${children.length} instancias activas para evitar overflow de pantalla ] ...`);
  console.log('=============================================================================================================================================');
  console.log(`⏱️  El test de estrés con 100 hilos finalizará automáticamente en unas horas.`);

  try {
    const reportPath = path.join(dataDir, 'stress_test_live_metrics.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      instances: children.map(inst => ({
        index: inst.index,
        strategy: inst.strategy,
        issuer: inst.issuer,
        ticks: inst.ticks,
        orders: inst.orders,
        errors: inst.errors,
        balance: inst.balance,
        pnl: inst.pnl,
        lastAction: inst.lastAction
      }))
    }, null, 2));
  } catch (err) {
    // Ignorar
  }
}, 5000);

function stopAllInstances() {
  clearInterval(monitorInterval);
  console.log('\n🛑 [TEST DE ESTRÉS] Finalizando los 100 worker_threads de forma segura...');
  
  for (const inst of children) {
    try {
      inst.worker.terminate();
    } catch (err) {
      // Ignore
    }
  }

  console.log('🏁 [TEST DE ESTRÉS] Test de 100 hilos detenido correctamente.');
  process.exit(0);
}

const timeout = setTimeout(() => {
  stopAllInstances();
}, RUN_DURATION_MS);

process.on('SIGINT', () => {
  clearTimeout(timeout);
  stopAllInstances();
});
