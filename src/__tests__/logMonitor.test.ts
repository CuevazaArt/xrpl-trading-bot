import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LogMonitor } from '../logMonitor.js';
import { JSONDatabase } from '../db.js';

describe('LogMonitor', () => {
  const tempLogPath = path.join(process.cwd(), 'data', 'test_app_raw.log');
  let mockDb: any;

  beforeEach(() => {
    // Limpiar archivo temporal de logs si existe
    if (fs.existsSync(tempLogPath)) {
      fs.unlinkSync(tempLogPath);
    }
    
    // Mock de base de datos
    mockDb = {
      logAnomaly: vi.fn(),
      getAnomalies: vi.fn().mockReturnValue([])
    };
  });

  afterEach(() => {
    if (fs.existsSync(tempLogPath)) {
      try { fs.unlinkSync(tempLogPath); } catch {}
    }
  });

  it('debe inicializarse e ignorar logs previos si se arranca con offset actual', async () => {
    // Escribir logs previos
    fs.writeFileSync(tempLogPath, '[2026-06-28T18:00:00.000Z] [ERR] [Main] Error previo a la ejecucion\n', 'utf8');

    const monitor = new LogMonitor(mockDb as unknown as JSONDatabase, tempLogPath);
    monitor.start(100);

    // Escribir log nuevo
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:02.000Z] [ERR] [Main] Nuevo error critico\n', 'utf8');

    // Esperar al polling
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(mockDb.logAnomaly).toHaveBeenCalledTimes(1);
    expect(mockDb.logAnomaly).toHaveBeenCalledWith('ERR', 'Nuevo error critico', { module: 'Main' });

    monitor.stop();
  });

  it('debe ignorar lineas irrelevantes como DEBUG o INFO', async () => {
    const monitor = new LogMonitor(mockDb as unknown as JSONDatabase, tempLogPath);
    monitor.start(100);

    // Escribir logs no anómalos
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:02.000Z] [INF] [Main] Conexión establecida\n', 'utf8');
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:03.000Z] [DBG] [DEX] Query cotización\n', 'utf8');

    await new Promise(resolve => setTimeout(resolve, 250));

    expect(mockDb.logAnomaly).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('debe aplicar deduplicacion temporal ante errores repetitivos', async () => {
    const monitor = new LogMonitor(mockDb as unknown as JSONDatabase, tempLogPath);
    monitor.start(100);

    // Escribir mismo error dos veces rápidamente
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:02.000Z] [ERR] [Wallet] Timeout de firma\n', 'utf8');
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:03.000Z] [ERR] [Wallet] Timeout de firma\n', 'utf8');

    await new Promise(resolve => setTimeout(resolve, 250));

    // Solo debería haberse registrado una vez por deduplicación
    expect(mockDb.logAnomaly).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('debe reiniciar offset si el log se trunca o rota', async () => {
    const monitor = new LogMonitor(mockDb as unknown as JSONDatabase, tempLogPath);
    monitor.start(100);

    // Escribir un error largo para avanzar el offset
    fs.appendFileSync(tempLogPath, '[2026-06-28T18:00:02.000Z] [ERR] [Main] Error original y sumamente largo para avanzar el offset del archivo de logs de prueba\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mockDb.logAnomaly).toHaveBeenCalledTimes(1);

    // Sobrescribir (truncar) el archivo con un error mucho más corto
    fs.writeFileSync(tempLogPath, '[2026-06-28T18:00:03.000Z] [ERR] [Main] Corto\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 250));

    // Debe detectar el truncamiento, leer de nuevo desde 0 y registrar el nuevo error
    expect(mockDb.logAnomaly).toHaveBeenCalledTimes(2);

    monitor.stop();
  });
});
