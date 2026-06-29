import { describe, it, expect } from 'vitest';
import { WeightGovernor } from '../cexAdapters/weightGovernor.js';

describe('WeightGovernor', () => {
  it('debe iniciarse en zona verde con peso cero', () => {
    const gov = new WeightGovernor(6000);
    const status = gov.getStatus();
    expect(status.zone).toBe('GREEN');
    expect(status.currentWeight).toBe(0);
    expect(status.pct).toBe(0);
  });

  it('debe dar permiso de forma inmediata (espera 0s) en zona verde (<= 50%)', () => {
    const gov = new WeightGovernor(6000);

    // Peso al 40% (2400 / 6000)
    gov.updateWeight(2400);
    
    const wait = gov.requestPermission('TestBot');
    expect(wait).toBe(0.0);
    expect(gov.getStatus().zone).toBe('GREEN');
  });

  it('debe aplicar retrasos dinámicos proporcionales en zona amarilla (50% a 80%)', () => {
    const gov = new WeightGovernor(6000);

    // Peso al 51% (3060 / 6000) -> Debería ser la frontera inferior (~2.9s)
    gov.updateWeight(3060);
    let wait = gov.requestPermission('TestBot');
    expect(gov.getStatus().zone).toBe('YELLOW');
    expect(wait).toBeCloseTo(2.9, 1);

    // Peso al 65% (medio de la zona amarilla) -> Debería ser alrededor de 16s
    gov.updateWeight(3900);
    wait = gov.requestPermission('TestBot');
    expect(wait).toBeCloseTo(16.0, 1);

    // Peso al 80% exacto (4800 / 6000) -> Debería ser la frontera superior (~30s)
    gov.updateWeight(4800);
    wait = gov.requestPermission('TestBot');
    expect(wait).toBeCloseTo(30.0, 1);
  });

  it('debe retornar Infinity (bloqueo total) en zona roja (> 80%)', () => {
    const gov = new WeightGovernor(6000);

    // Peso al 81% (4860 / 6000)
    gov.updateWeight(4860);
    
    const wait = gov.requestPermission('TestBot');
    expect(gov.getStatus().zone).toBe('RED');
    expect(wait).toBe(Infinity);
  });

  it('debe reportar la antigüedad de la telemetría correctamente', async () => {
    const gov = new WeightGovernor(6000);
    expect(gov.getStatus().lastUpdateAgeSeconds).toBeNull();

    gov.updateWeight(100);
    expect(gov.getStatus().lastUpdateAgeSeconds).toBeLessThan(1);
  });
});
