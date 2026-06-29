import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIFuse } from '../cexAdapters/apiFuse.js';

describe('APIFuse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debe iniciarse en estado conectado (sin disparar)', () => {
    const fuse = new APIFuse(80, 60, 6000, 3600);
    expect(fuse.isTripped()).toBe(false);
    expect(fuse.remainingCooldownSeconds()).toBe(0);
  });

  it('debe dispararse si el peso consumido supera el umbral del 80%', () => {
    const fuse = new APIFuse(80, 60, 6000, 3600);
    
    // Peso menor al umbral (e.g., 4700 / 6000 = 78.3%)
    fuse.checkWeight(4700);
    expect(fuse.isTripped()).toBe(false);

    // Peso igual o superior al umbral (e.g., 4800 / 6000 = 80%)
    fuse.checkWeight(4800);
    expect(fuse.isTripped()).toBe(true);
    expect(fuse.remainingCooldownSeconds()).toBe(60);
  });

  it('debe dispararse inmediatamente ante errores fatales de Binance (429, -1003)', () => {
    const fuse = new APIFuse(80, 60, 6000, 3600);
    
    // Un error normal no lo dispara
    fuse.onErrorCode(-2010, 'Account has insufficient balance');
    expect(fuse.isTripped()).toBe(false);

    // Un error fatal sí (e.g., 429 Rate Limit Exceeded)
    fuse.onErrorCode(429, 'Too Many Requests');
    expect(fuse.isTripped()).toBe(true);
    
    // Los errores fatales fuerzan el cooldown máximo (3600s)
    expect(fuse.remainingCooldownSeconds()).toBe(3600);
  });

  it('debe restablecerse automáticamente tras transcurrir el cooldown', () => {
    const fuse = new APIFuse(80, 60, 6000, 3600);
    
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);

    // Avanzar el tiempo 59 segundos (faltaría 1 segundo)
    vi.advanceTimersByTime(59 * 1000);
    expect(fuse.isTripped()).toBe(true);

    // Avanzar 1 segundo más
    vi.advanceTimersByTime(1 * 1000);
    expect(fuse.isTripped()).toBe(false);
  });

  it('debe escalar exponencialmente el cooldown ante disparos consecutivos en la ventana de gracia', () => {
    // Cooldown base = 60s, Ventana de gracia = 120s
    const fuse = new APIFuse(80, 60, 6000, 3600);

    // Disparo 1: Cooldown base = 60s
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);
    expect(fuse.remainingCooldownSeconds()).toBe(60);

    // Esperar a que pase el cooldown y se resetee (e.g., 60s)
    vi.advanceTimersByTime(60 * 1000);
    expect(fuse.isTripped()).toBe(false);

    // Disparo 2 (dentro de la ventana de gracia de 120s): Cooldown = 60 * 2 = 120s
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);
    expect(fuse.remainingCooldownSeconds()).toBe(120);

    // Esperar a que pase el cooldown y se resetee (120s)
    vi.advanceTimersByTime(120 * 1000);
    expect(fuse.isTripped()).toBe(false);

    // Esperar más allá de la ventana de gracia de 120s (e.g., 150s)
    vi.advanceTimersByTime(150 * 1000);

    // Disparo 3 (racha rota): Se reinicia al cooldown base de 60s
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);
    expect(fuse.remainingCooldownSeconds()).toBe(60);
  });

  it('debe poder restablecerse manualmente y limpiar la racha de escalada', () => {
    const fuse = new APIFuse(80, 60, 6000, 3600);

    // Disparo 1
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);

    // Restablecimiento manual
    fuse.manualReset();
    expect(fuse.isTripped()).toBe(false);
    expect(fuse.remainingCooldownSeconds()).toBe(0);

    // Disparo 2 (debería ser base porque la racha se limpió)
    fuse.checkWeight(5000);
    expect(fuse.isTripped()).toBe(true);
    expect(fuse.remainingCooldownSeconds()).toBe(60);
  });
});
