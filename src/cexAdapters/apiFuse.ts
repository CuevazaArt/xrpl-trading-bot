import { createLogger } from '../logger.js';

const log = createLogger('APIFuse');

// Error codes that trigger an IMMEDIATE fuse trip.
const FATAL_CODES = new Set([-1003, 429, 418, -1015]);

// Grace window: after a reset, if it re-trips within 2 minutes, the cooldown escalates (doubles).
const GRACE_WINDOW_MS = 120 * 1000;

export class APIFuse {
  private thresholdPct: number;
  private baseCooldownMs: number;
  private weightLimit: number;
  private maxCooldownMs: number;

  private tripped = false;
  private trippedAt = 0;
  private resetAt = 0;
  private currentCooldownMs: number;
  private tripReason = '';
  private tripCount = 0;
  private consecutiveStreak = 0;

  constructor(
    thresholdPct = 80.0,
    cooldownSeconds = 300,
    weightLimit = 6000,
    maxCooldownSeconds = 3600
  ) {
    this.thresholdPct = Math.max(10, Math.min(thresholdPct, 99));
    this.baseCooldownMs = Math.max(30, cooldownSeconds) * 1000;
    this.weightLimit = Math.max(1, weightLimit);
    this.maxCooldownMs = Math.max(cooldownSeconds, maxCooldownSeconds) * 1000;
    this.currentCooldownMs = this.baseCooldownMs;
  }

  checkWeight(usedWeight: number): boolean {
    if (usedWeight <= 0) {
      return this.isTripped();
    }
    const pct = (usedWeight / this.weightLimit) * 100;
    if (pct >= this.thresholdPct) {
      const reason = `Peso API al ${pct.toFixed(1)}% (${usedWeight}/${this.weightLimit}). Umbral: ${this.thresholdPct}%`;
      this.trip(reason);
      return true;
    }
    return this.isTripped();
  }

  onErrorCode(code: number, message = ''): boolean {
    if (FATAL_CODES.has(code)) {
      const reason = `Error crítico Binance: code=${code} msg=${message.substring(0, 200)}`;
      this.trip(reason, true);
      return true;
    }
    return false;
  }

  isTripped(): boolean {
    if (!this.tripped) {
      return false;
    }
    const elapsed = Date.now() - this.trippedAt;
    if (elapsed >= this.currentCooldownMs) {
      this.resetAt = Date.now();
      this.tripped = false;
      log.info(`API Fuse auto-reset después de ${(elapsed / 1000).toFixed(0)}s de cooldown (trip #${this.tripCount}, streak=${this.consecutiveStreak}, siguiente cooldown si re-tripea: ${this.getNextEscalatedCooldown() / 1000}s)`);
      return false;
    }
    return true;
  }

  remainingCooldownSeconds(): number {
    if (!this.tripped) return 0;
    return Math.max(0, (this.currentCooldownMs - (Date.now() - this.trippedAt)) / 1000);
  }

  manualReset(): void {
    this.tripped = false;
    this.consecutiveStreak = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.resetAt = Date.now();
    log.warn('API Fuse restablecido manualmente por el operador. Racha de escalada limpia.');
  }

  private getNextEscalatedCooldown(): number {
    const inGrace = this.resetAt > 0 && (Date.now() - this.resetAt) < GRACE_WINDOW_MS;
    const nextStreak = inGrace || this.consecutiveStreak === 0 ? this.consecutiveStreak + 1 : 1;
    return Math.min(this.baseCooldownMs * Math.pow(2, nextStreak - 1), this.maxCooldownMs);
  }

  private trip(reason: string, forceMax = false): void {
    if (this.tripped) {
      return;
    }

    const now = Date.now();
    const inGraceWindow = this.resetAt > 0 && (now - this.resetAt) < GRACE_WINDOW_MS;

    if (inGraceWindow || this.consecutiveStreak === 0) {
      this.consecutiveStreak++;
    } else {
      this.consecutiveStreak = 1;
    }

    if (forceMax) {
      this.currentCooldownMs = this.maxCooldownMs;
    } else {
      this.currentCooldownMs = Math.min(
        this.baseCooldownMs * Math.pow(2, this.consecutiveStreak - 1),
        this.maxCooldownMs
      );
    }

    this.tripped = true;
    this.trippedAt = now;
    this.tripReason = reason;
    this.tripCount++;

    log.error(`🚨 API FUSE TRIPPED (#${this.tripCount}, streak=${this.consecutiveStreak}): ${reason} — LLAMADAS API REST BLOQUEADAS POR ${this.currentCooldownMs / 1000}s`);
  }

  getStatus() {
    const remaining = this.remainingCooldownSeconds();
    return {
      tripped: this.tripped,
      reason: this.tripped ? this.tripReason : '',
      remainingCooldownSeconds: Math.round(remaining * 10) / 10,
      tripCount: this.tripCount,
      consecutiveStreak: this.consecutiveStreak,
      currentCooldownSeconds: this.currentCooldownMs / 1000,
      nextCooldownSeconds: this.getNextEscalatedCooldown() / 1000,
      thresholdPct: this.thresholdPct,
      weightLimit: this.weightLimit
    };
  }
}

export const apiFuse = new APIFuse();
