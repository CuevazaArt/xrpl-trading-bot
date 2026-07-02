import { db } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('PurgeState');

async function main() {
  log.warn('⚠️ Iniciando purga del estado de Helena Agartha Binance...');
  
  // Guardamos un objeto vacío para resetear el estado de posiciones de trailing
  db.saveCustomData('binance_agartha_state', {});
  
  log.warn('✅ Estado de Helena Agartha purgado con éxito en helena.db.');
  
  // Esperar un momento para asegurar que la transacción de SQLite en modo WAL se complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  log.info('Finalizado.');
  process.exit(0);
}

main().catch(err => {
  log.error('❌ Error al purgar el estado:', err);
  process.exit(1);
});
