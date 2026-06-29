import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Matrix of strategies and symbol gateways
const STRATEGIES = [
  'market_maker',
  'dorothy',
  'elphaba',
  'louise',
  'anti_louise',
  'masha',
  'thusnelda',
  'agartha'
];

const ISSUERS = [
  'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', // Bitstamp USD
  'rhub8VRN42sZ34fpTCwWqBnmg3gmeqn14t', // Gatehub USD
  'rMinIssuer33333333333333333333333'  // Mock Issuer
];

const RUN_DURATION_MS = 86400000; // Run for 24 hours (or until manually stopped)
const children = [];

console.log('🚀 [TEST DE ESTRÉS] Iniciando fase de compilación...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ [TEST DE ESTRÉS] Compilación completa en dist/.');
} catch (buildErr) {
  console.error('❌ [TEST DE ESTRÉS] Error durante la compilación:', buildErr.message);
  process.exit(1);
}

// Ensure data folder exists for logs
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

console.log(`🚀 [TEST DE ESTRÉS] Lanzando ${STRATEGIES.length * ISSUERS.length} instancias en paralelo (Modo Paper Trading) con espaciado de 350ms...`);

(async () => {
  let index = 0;
  for (const strategy of STRATEGIES) {
    for (const issuer of ISSUERS) {
      const instanceIndex = index++;
      
      // Espaciar el lanzamiento para evitar ráfagas de conexión en el nodo RPC público
      await new Promise(resolve => setTimeout(resolve, 350));
      
      const logFile = path.join(dataDir, `stress_test_instance_${instanceIndex}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'w' });

      const env = {
        ...process.env,
        STRATEGY: strategy,
        USD_ISSUER: issuer,
        DASHBOARD_PORT: String(3100 + instanceIndex),
        LOG_LEVEL: 'INFO'
      };

      // Launch via Node.js directly to dist/index.js
      const child = spawn('node', ['dist/index.js', '--paper-trading', '--skip-swap', '--no-dashboard'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);

      children.push({
        child,
        strategy,
        issuer,
        index: instanceIndex,
        logFile,
        ticks: 0,
        orders: 0,
        errors: 0
      });
    }
  }

  console.log(`✅ [TEST DE ESTRÉS] Las 24 instancias se han lanzado con éxito.`);
  console.log(`ℹ️  Logs individuales guardados en: data/stress_test_instance_*.log`);
  console.log('📊 Monitoreando ejecución en paralelo. Presione Ctrl+C para finalizar antes de tiempo...\n');
})();

// Monitor logs for ticks, orders, and errors
const monitorInterval = setInterval(() => {
  console.clear();
  console.log('=============================================================================');
  console.log(` 📊 PANEL DE MONITOREO DE TEST DE ESTRÉS (Helena - 24 Instancias Concurrentes)`);
  console.log('=============================================================================');
  console.log('ID | Estrategia       | Emisor / Gateway                   | Ticks | Órdenes | Errores');
  console.log('---|------------------|------------------------------------|-------|---------|--------');

  for (const inst of children) {
    try {
      if (fs.existsSync(inst.logFile)) {
        const content = fs.readFileSync(inst.logFile, 'utf8');
        
        // Count events based on log messages
        inst.ticks = (content.match(/tick/gi) || []).length;
        inst.orders = (content.match(/Compra exitosa|Venta exitosa|colocada|creada|PAPER_CEX_/gi) || []).length;
        inst.errors = (content.match(/error|exception|falló|crítica/gi) || []).length;
      }
    } catch {
      // Ignore read conflicts
    }

    const idStr = String(inst.index).padStart(2, '0');
    const stratStr = inst.strategy.padEnd(16, ' ');
    const issuerStr = (inst.issuer.substring(0, 8) + '...' + inst.issuer.slice(-8)).padEnd(34, ' ');
    const tickStr = String(inst.ticks).padStart(5, ' ');
    const orderStr = String(inst.orders).padStart(7, ' ');
    const errorStr = String(inst.errors).padStart(7, ' ');

    console.log(`${idStr} | ${stratStr} | ${issuerStr} | ${tickStr} | ${orderStr} | ${errorStr}`);
  }
  console.log('=============================================================================');
  console.log(`⏱️  El test de estrés finalizará automáticamente en unos momentos.`);
}, 5000);

// Graceful shutdown function
function stopAllInstances() {
  clearInterval(monitorInterval);
  console.log('\n🛑 [TEST DE ESTRÉS] Deteniendo todas las instancias de forma elegante (SIGINT)...');
  
  for (const inst of children) {
    try {
      inst.child.kill('SIGINT');
    } catch (err) {
      // Ignore
    }
  }

  // Allow 5 seconds for clean cancel-before-exit and shutdown before hard kill
  setTimeout(() => {
    console.log('🧹 [TEST DE ESTRÉS] Realizando limpieza de procesos...');
    for (const inst of children) {
      try {
        inst.child.kill('SIGKILL');
      } catch (err) {
        // Ignore
      }
    }
    console.log('🏁 [TEST DE ESTRÉS] Test finalizado correctamente.');
    process.exit(0);
  }, 5000);
}

// Setup timeout for automated termination
const timeout = setTimeout(() => {
  stopAllInstances();
}, RUN_DURATION_MS);

// Capture terminal signals
process.on('SIGINT', () => {
  clearTimeout(timeout);
  stopAllInstances();
});
