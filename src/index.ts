import { config } from './config.js';
import { XRPLWebsocketReader } from './websocketReader.js';

async function main() {
  console.log('Iniciando bot de trading XRPL - Módulo WebSocket Reader...');
  
  const reader = new XRPLWebsocketReader(config.xrplWsUrl);

  try {
    await reader.start();
  } catch (error) {
    console.error('Error crítico al iniciar el lector WebSocket:', error);
    process.exit(1);
  }

  // Manejo de apagado controlado (Graceful shutdown)
  const gracefulShutdown = async () => {
    console.log('\nRecibida señal de apagado. Limpiando recursos...');
    try {
      await reader.stop();
      console.log('Apagado completado con éxito.');
      process.exit(0);
    } catch (error) {
      console.error('Error durante el apagado:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch((error) => {
  console.error('Error no controlado en la ejecución principal:', error);
  process.exit(1);
});
