import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VenueExpansionManager, EXPANSION_CANDIDATES } from '../venueExpansionManager.js';
import { JSONDatabase } from '../db.js';

describe('VenueExpansionManager', () => {
  let mockDb: any;
  let customStore: Record<string, any>;

  beforeEach(() => {
    customStore = {};
    mockDb = {
      saveCustomData: vi.fn().mockImplementation((key, val) => {
        customStore[key] = val;
      }),
      getCustomData: vi.fn().mockImplementation((key) => {
        return customStore[key];
      }),
      getAnomalies: vi.fn().mockReturnValue([])
    };
  });

  it('debe inicializar el estado por defecto si no hay datos guardados', () => {
    const manager = new VenueExpansionManager(mockDb as unknown as JSONDatabase);
    
    expect(manager.getActiveVenues()).toContain('xrpl_dex');
    expect(manager.getActiveVenues()).toContain('mock_cex');
    expect(manager.isUpgradePrompted()).toBe(false);
  });

  it('debe ignorar ticks de expansion si no ha transcurrido la ventana de tiempo', async () => {
    const manager = new VenueExpansionManager(mockDb as unknown as JSONDatabase);
    
    // Configurar fecha de inicio muy reciente (ahora mismo)
    customStore['expansionState'].currentPhaseStartTime = new Date().toISOString();
    
    await manager.evaluateExpansionTick(false);
    expect(manager.isUpgradePrompted()).toBe(false);
  });

  it('debe sugerir upgrade al siguiente venue si transcurre la ventana de tiempo sin errores', async () => {
    const manager = new VenueExpansionManager(mockDb as unknown as JSONDatabase);
    
    // Establecer fecha de inicio en el pasado para forzar vencimiento
    customStore['expansionState'].currentPhaseStartTime = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // Hace 30h
    
    await manager.evaluateExpansionTick(false);
    
    expect(manager.isUpgradePrompted()).toBe(true);
    expect(customStore['expansionState'].upgradePrompted).toBe(true);
  });

  it('debe bloquear la sugerencia e iniciar un nuevo cooldown si se detectan anomalias recientes', async () => {
    const manager = new VenueExpansionManager(mockDb as unknown as JSONDatabase);
    
    // Hace 30 horas
    const pastTime = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    customStore['expansionState'].currentPhaseStartTime = pastTime;
    
    // Mockear una anomalía ocurrida hace 10 horas (dentro de la fase activa)
    const anomalyTime = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    mockDb.getAnomalies.mockReturnValue([
      { timestamp: anomalyTime, type: 'ERR', message: 'Fallo de oraculo de prueba' }
    ]);

    await manager.evaluateExpansionTick(false);

    // No debe disparar el upgrade
    expect(manager.isUpgradePrompted()).toBe(false);
    // Debe haber restablecido la fecha de inicio a la fecha actual (se reinicia la ventana)
    expect(new Date(customStore['expansionState'].currentPhaseStartTime).getTime()).toBeGreaterThan(new Date(pastTime).getTime());
  });

  it('debe activar el venue candidato agregandolo a activeVenues y reiniciando el prompt', () => {
    const manager = new VenueExpansionManager(mockDb as unknown as JSONDatabase);
    
    // Habilitar prompt previo
    customStore['expansionState'].upgradePrompted = true;

    manager.activateNextVenue('binance');

    expect(manager.getActiveVenues()).toContain('binance');
    expect(manager.isUpgradePrompted()).toBe(false);
    expect(customStore['expansionState'].upgradePrompted).toBe(false);
  });
});
