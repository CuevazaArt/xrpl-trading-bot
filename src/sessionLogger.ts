import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('SessionLog');

// =====================================================================
// SESSION RECORD INTERFACES
// =====================================================================

export interface SessionModeStats {
  mode: string;
  fills: number;
  feesDrops: number;
  ticks: number;
  rotations: number;
  iocAttempts: number;
  iocHits: number;
  iocHitRate: string;
}

export interface SessionSnapshot {
  timestamp: string;
  tick: number;
  ledger: number;
  mode: string;
  price: number;
  xrpBalance: number;
  pnlUsd: number;
  feesDrops: number;
  fills: number;
  roundtrips: number;
}

export interface SessionRecord {
  // Identity
  sessionId: string;
  instance: string;             // e.g. "Helena × Kyoto :: Sashimi"
  strategy: string;
  connector: string;
  pair: string;

  // Timing
  startTime: string;
  endTime: string;
  durationMinutes: number;

  // Config snapshot (for comparing what settings produced what results)
  config: {
    baseSpread: number;
    tightSpread: number;
    iocMinEdge: number;
    orderAmountXrp: number;
    cooldownLedgers: number;
    maxSessionFeeDrops: number;
    maxLossUsd: number;
    carouselTight: number;
    carouselStandard: number;
    carouselIoc: number;
    carouselRest: number;
  };

  // Performance summary
  performance: {
    totalTicks: number;
    totalFills: number;
    completedRoundtrips: number;
    pendingBuys: number;
    pendingSells: number;
    grossProfitUsd: number;
    feesUsd: number;
    netProfitUsd: number;
    winRate: number;
    avgProfitPerRt: number;
    bestTradeUsd: number;
    worstTradeUsd: number;
  };

  // Fee analysis
  fees: {
    totalDrops: number;
    dropsPerTick: number;
    dropsPerFill: number;
    budgetUsedPercent: number;
    circuitBreakerTriggered: boolean;
  };

  // Mode breakdown
  modeStats: SessionModeStats[];

  // Carousel efficiency
  carousel: {
    totalRotations: number;
    mostProductiveMode: string;
    fillsPerRotation: number;
  };

  // Snapshots (periodic for time-series analysis)
  snapshots: SessionSnapshot[];

  // End reason
  endReason: 'graceful_shutdown' | 'circuit_breaker' | 'stop_loss' | 'error' | 'manual';
  endDetail?: string;
}

// =====================================================================
// SESSION LOGGER
// =====================================================================

export class SessionLogger {
  private sessionId: string;
  private startTime: Date;
  private snapshots: SessionSnapshot[] = [];
  private endReason: SessionRecord['endReason'] = 'graceful_shutdown';
  private endDetail?: string;
  private snapshotInterval: number = 60_000; // Snapshot every 60s
  private lastSnapshotTime: number = 0;
  private sessionsDir: string;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.startTime = new Date();

    this.sessionsDir = path.join(process.cwd(), 'data', 'sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    log.info(`Session started: ${this.sessionId}`);
  }

  private generateSessionId(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toISOString().slice(11, 19).replace(/:/g, '');
    const rand = Math.random().toString(36).slice(2, 6);
    return `${date}_${time}_${rand}`;
  }

  /**
   * Record a periodic snapshot of the bot's state.
   * Call this from the strategy tick — it self-throttles to snapshotInterval.
   */
  recordSnapshot(data: {
    tick: number;
    ledger: number;
    mode: string;
    price: number;
    xrpBalance: number;
    pnlUsd: number;
    feesDrops: number;
    fills: number;
    roundtrips: number;
  }): void {
    const now = Date.now();
    if (now - this.lastSnapshotTime < this.snapshotInterval) return;

    this.lastSnapshotTime = now;
    this.snapshots.push({
      timestamp: new Date().toISOString(),
      ...data,
    });
  }

  /** Set end reason (for when bot pauses or crashes) */
  setEndReason(reason: SessionRecord['endReason'], detail?: string): void {
    this.endReason = reason;
    this.endDetail = detail;
  }

  /**
   * Finalize and save the session record to disk.
   * Call this on shutdown.
   */
  async finalize(data: {
    totalTicks: number;
    modeStats: Record<string, {
      fills: number;
      feesSpentDrops: number;
      ticksActive: number;
      rotations: number;
      iocAttempts: number;
      iocHits: number;
    }>;
    pnlSummary: {
      totalFills: number;
      completedRoundtrips: number;
      pendingBuys: number;
      pendingSells: number;
      totalGrossProfitUsd: number;
      totalFeesUsd: number;
      totalNetProfitUsd: number;
      winRate: number;
      avgProfitPerRoundtrip: number;
      bestTradeUsd: number;
      worstTradeUsd: number;
    };
    totalFeesDrops: number;
    totalRotations: number;
  }): Promise<void> {
    const endTime = new Date();
    const durationMs = endTime.getTime() - this.startTime.getTime();
    const durationMinutes = Math.round(durationMs / 60_000 * 10) / 10;

    // Find most productive mode
    let bestMode = '';
    let bestFills = -1;
    const modeStatsArray: SessionModeStats[] = [];

    for (const [mode, stats] of Object.entries(data.modeStats)) {
      const hitRate = stats.iocAttempts > 0
        ? ((stats.iocHits / stats.iocAttempts) * 100).toFixed(1) + '%'
        : 'N/A';

      modeStatsArray.push({
        mode,
        fills: stats.fills,
        feesDrops: stats.feesSpentDrops,
        ticks: stats.ticksActive,
        rotations: stats.rotations,
        iocAttempts: stats.iocAttempts,
        iocHits: stats.iocHits,
        iocHitRate: hitRate,
      });

      if (stats.fills > bestFills) {
        bestFills = stats.fills;
        bestMode = mode;
      }
    }

    const totalFills = data.pnlSummary.totalFills;
    const record: SessionRecord = {
      sessionId: this.sessionId,
      instance: 'Helena × Kyoto :: Sashimi',
      strategy: 'market_maker',
      connector: 'xrpl-dex',
      pair: 'XRP/USD',

      startTime: this.startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMinutes,

      config: {
        baseSpread: config.mmBaseSpread,
        tightSpread: config.mmTightSpread,
        iocMinEdge: config.mmIocMinDexEdge,
        orderAmountXrp: config.mmOrderAmountXrp,
        cooldownLedgers: config.mmCooldownLedgers,
        maxSessionFeeDrops: config.mmMaxSessionFeeDrops,
        maxLossUsd: config.mmMaxLossUsd,
        carouselTight: config.mmCarouselTightLedgers,
        carouselStandard: config.mmCarouselStandardLedgers,
        carouselIoc: config.mmCarouselIocLedgers,
        carouselRest: config.mmCarouselRestLedgers,
      },

      performance: {
        totalTicks: data.totalTicks,
        totalFills: totalFills,
        completedRoundtrips: data.pnlSummary.completedRoundtrips,
        pendingBuys: data.pnlSummary.pendingBuys,
        pendingSells: data.pnlSummary.pendingSells,
        grossProfitUsd: data.pnlSummary.totalGrossProfitUsd,
        feesUsd: data.pnlSummary.totalFeesUsd,
        netProfitUsd: data.pnlSummary.totalNetProfitUsd,
        winRate: data.pnlSummary.winRate,
        avgProfitPerRt: data.pnlSummary.avgProfitPerRoundtrip,
        bestTradeUsd: data.pnlSummary.bestTradeUsd,
        worstTradeUsd: data.pnlSummary.worstTradeUsd,
      },

      fees: {
        totalDrops: data.totalFeesDrops,
        dropsPerTick: data.totalTicks > 0 ? Math.round(data.totalFeesDrops / data.totalTicks) : 0,
        dropsPerFill: totalFills > 0 ? Math.round(data.totalFeesDrops / totalFills) : 0,
        budgetUsedPercent: Math.round((data.totalFeesDrops / config.mmMaxSessionFeeDrops) * 100),
        circuitBreakerTriggered: data.totalFeesDrops >= config.mmMaxSessionFeeDrops,
      },

      modeStats: modeStatsArray,

      carousel: {
        totalRotations: data.totalRotations,
        mostProductiveMode: bestMode,
        fillsPerRotation: data.totalRotations > 0 ? Math.round((totalFills / data.totalRotations) * 100) / 100 : 0,
      },

      snapshots: this.snapshots,
      endReason: this.endReason,
      endDetail: this.endDetail,
    };

    // Save to file
    const filename = `session_${this.sessionId}.json`;
    const filepath = path.join(this.sessionsDir, filename);

    try {
      await fsp.writeFile(filepath, JSON.stringify(record, null, 2), 'utf8');
      log.info(`Session saved: ${filename} (${durationMinutes}min, ${totalFills} fills, $${data.pnlSummary.totalNetProfitUsd.toFixed(4)} net)`);
    } catch (err) {
      log.error('Failed to save session record:', err);
    }

    // Also update the sessions index
    await this.updateIndex(record);
  }

  /**
   * Maintains a lightweight index of all sessions for quick comparison.
   */
  private async updateIndex(record: SessionRecord): Promise<void> {
    const indexPath = path.join(this.sessionsDir, 'sessions_index.json');

    let index: SessionIndexEntry[] = [];
    try {
      if (fs.existsSync(indexPath)) {
        const raw = await fsp.readFile(indexPath, 'utf8');
        index = JSON.parse(raw);
      }
    } catch {
      index = [];
    }

    index.push({
      sessionId: record.sessionId,
      instance: record.instance,
      startTime: record.startTime,
      durationMinutes: record.durationMinutes,
      ticks: record.performance.totalTicks,
      fills: record.performance.totalFills,
      roundtrips: record.performance.completedRoundtrips,
      netPnlUsd: record.performance.netProfitUsd,
      winRate: record.performance.winRate,
      feesDrops: record.fees.totalDrops,
      endReason: record.endReason,
      // Config diffs for A/B comparison
      iocMinEdge: record.config.iocMinEdge,
      baseSpread: record.config.baseSpread,
    });

    try {
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch (err) {
      log.error('Failed to update sessions index:', err);
    }
  }
}

interface SessionIndexEntry {
  sessionId: string;
  instance: string;
  startTime: string;
  durationMinutes: number;
  ticks: number;
  fills: number;
  roundtrips: number;
  netPnlUsd: number;
  winRate: number;
  feesDrops: number;
  endReason: string;
  iocMinEdge: number;
  baseSpread: number;
}
