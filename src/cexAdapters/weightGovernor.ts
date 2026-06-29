import { createLogger } from '../logger.js';

const log = createLogger('WeightGovernor');

const DEFAULT_WEIGHT_LIMIT = 6000;
const GREEN_CEILING = 0.50; // 50%
const YELLOW_CEILING = 0.80; // 80%

export class WeightGovernor {
  private weightLimit: number;
  private currentWeight = 0;
  private lastUpdateTs = 0;

  constructor(weightLimit = DEFAULT_WEIGHT_LIMIT) {
    this.weightLimit = weightLimit;
  }

  updateWeight(usedWeight1m: number): void {
    this.currentWeight = Math.max(0, Math.floor(usedWeight1m));
    this.lastUpdateTs = Date.now();
  }

  private getPct(): number {
    if (this.weightLimit <= 0) return 0;
    return this.currentWeight / this.weightLimit;
  }

  private getZone(): 'GREEN' | 'YELLOW' | 'RED' {
    const pct = this.getPct();
    if (pct <= GREEN_CEILING) return 'GREEN';
    if (pct <= YELLOW_CEILING) return 'YELLOW';
    return 'RED';
  }

  requestPermission(botId: string): number {
    const zone = this.getZone();
    const pct = this.getPct();

    if (zone === 'GREEN') {
      return 0.0;
    }

    if (zone === 'RED') {
      log.warn(`WeightGovernor: Zona ROJA (${(pct * 100).toFixed(0)}%) — bloqueando petición para ${botId}`);
      return Infinity;
    }

    // YELLOW: proporcional backoff 2s a 30s basado en la presión de peso.
    const pressure = (pct - GREEN_CEILING) / (YELLOW_CEILING - GREEN_CEILING);
    const wait = 2.0 + pressure * 28.0;
    log.info(`WeightGovernor: Zona AMARILLA (${(pct * 100).toFixed(0)}%) — retrasando petición de ${botId} por ${wait.toFixed(1)}s`);
    return wait;
  }

  getStatus() {
    const pct = this.getPct();
    const zone = this.getZone();
    const age = this.lastUpdateTs > 0 ? (Date.now() - this.lastUpdateTs) / 1000 : null;
    return {
      zone,
      currentWeight: this.currentWeight,
      weightLimit: this.weightLimit,
      pct: Math.round(pct * 1000) / 10,
      lastUpdateAgeSeconds: age !== null ? Math.round(age * 10) / 10 : null
    };
  }
}

export const weightGovernor = new WeightGovernor();
