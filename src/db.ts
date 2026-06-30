import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('Database');

interface TransactionRecord {
  timestamp: string;
  type: string;
  hash: string;
  status: string;
  detail: any;
}

interface BalanceRecord {
  timestamp: string;
  xrp: string;
  usd: string;
}

export class JSONDatabase {
  private dbPath: string;
  private db: Database | null = null;
  private strategy: string;
  private usdIssuer: string;
  private initPromise: Promise<void> = Promise.resolve();
  private isTest: boolean;
  
  // JSON Database specific fields (for test mode)
  private writeQueue: Promise<void> = Promise.resolve();

  private cache: {
    transactions: TransactionRecord[];
    balances: BalanceRecord[];
    custom: Record<string, any>;
    anomalies: any[];
  } = {
    transactions: [],
    balances: [],
    custom: {},
    anomalies: []
  };

  constructor() {
    this.isTest = process.env.NODE_ENV === 'test';
    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.strategy = config.strategy || 'unknown';
    this.usdIssuer = config.usdIssuer || 'default';

    if (this.isTest) {
      this.dbPath = path.join(dir, 'db.json');
      if (fs.existsSync(this.dbPath)) {
        try {
          const fileContent = fs.readFileSync(this.dbPath, 'utf8');
          const parsed = JSON.parse(fileContent);
          this.cache = {
            transactions: parsed.transactions || [],
            balances: parsed.balances || [],
            custom: parsed.custom || {},
            anomalies: parsed.custom?.anomalies || []
          };
        } catch (error) {
          this.cache = { transactions: [], balances: [], custom: {}, anomalies: [] };
        }
      }
    } else {
      this.dbPath = path.join(dir, 'helena.db');
      this.initPromise = this.init();
    }
  }

  private async init(): Promise<void> {
    try {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Habilitar el modo WAL para permitir escrituras y lecturas concurrentes a gran escala
      await this.db.exec('PRAGMA journal_mode = WAL;');
      await this.db.exec('PRAGMA synchronous = NORMAL;');

      // Crear tablas necesarias
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy TEXT,
          usd_issuer TEXT,
          timestamp TEXT,
          type TEXT,
          hash TEXT,
          status TEXT,
          detail TEXT
        )
      `);

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS balances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy TEXT,
          usd_issuer TEXT,
          timestamp TEXT,
          xrp TEXT,
          usd TEXT
        )
      `);

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_data (
          strategy TEXT,
          usd_issuer TEXT,
          key TEXT,
          value TEXT,
          PRIMARY KEY (strategy, usd_issuer, key)
        )
      `);

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS anomalies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy TEXT,
          usd_issuer TEXT,
          timestamp TEXT,
          type TEXT,
          message TEXT,
          details TEXT
        )
      `);

      // Cargar los datos históricos a la caché en memoria
      const txRows = await this.db.all(
        `SELECT timestamp, type, hash, status, detail FROM transactions WHERE strategy = ? AND usd_issuer = ? ORDER BY id ASC`,
        this.strategy,
        this.usdIssuer
      );
      this.cache.transactions = txRows.map(r => ({
        timestamp: r.timestamp,
        type: r.type,
        hash: r.hash,
        status: r.status,
        detail: JSON.parse(r.detail)
      }));

      this.cache.balances = await this.db.all(
        `SELECT timestamp, xrp, usd FROM balances WHERE strategy = ? AND usd_issuer = ? ORDER BY id ASC`,
        this.strategy,
        this.usdIssuer
      );

      const customRows = await this.db.all(
        `SELECT key, value FROM custom_data WHERE strategy = ? AND usd_issuer = ?`,
        this.strategy,
        this.usdIssuer
      );
      for (const row of customRows) {
        this.cache.custom[row.key] = JSON.parse(row.value);
      }

      const anomalyRows = await this.db.all(
        `SELECT timestamp, type, message, details FROM anomalies WHERE strategy = ? AND usd_issuer = ? ORDER BY id ASC`,
        this.strategy,
        this.usdIssuer
      );
      this.cache.anomalies = anomalyRows.map(r => ({
        timestamp: r.timestamp,
        type: r.type,
        message: r.message,
        details: JSON.parse(r.details)
      }));

      log.info(`Base de datos SQLite inicializada en modo WAL (Caché en memoria precargada).`);
    } catch (err: any) {
      log.error('Error durante la inicialización de SQLite:', err.message || err);
    }
  }

  async ensureInitialized(): Promise<void> {
    if (!this.isTest) {
      await this.initPromise;
    }
  }

  private enqueueWrite() {
    if (this.isTest) {
      this.writeQueue = this.writeQueue.then(async () => {
        const tmpPath = this.dbPath + '.tmp';
        try {
          const payload = {
            transactions: this.cache.transactions,
            balances: this.cache.balances,
            custom: {
              ...this.cache.custom,
              anomalies: this.cache.anomalies
            }
          };
          await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
          await fsp.rename(tmpPath, this.dbPath);
        } catch (error) {
          log.error('Error al escribir en la base de datos JSON de prueba:', error);
          try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
        }
      });
    }
  }

  logTransaction(type: string, hash: string, status: string, detail: any = {}) {
    const record: TransactionRecord = {
      timestamp: new Date().toISOString(),
      type,
      hash,
      status,
      detail
    };
    this.cache.transactions.push(record);
    if (this.cache.transactions.length > 200) {
      this.cache.transactions.shift();
    }

    if (this.isTest) {
      this.enqueueWrite();
    } else {
      this.initPromise.then(async () => {
        try {
          await this.db!.run(
            `INSERT INTO transactions (strategy, usd_issuer, timestamp, type, hash, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            this.strategy,
            this.usdIssuer,
            record.timestamp,
            record.type,
            record.hash,
            record.status,
            JSON.stringify(record.detail)
          );

          const row = await this.db!.get(
            `SELECT id FROM transactions WHERE strategy = ? AND usd_issuer = ? ORDER BY id DESC LIMIT 1 OFFSET 200`,
            this.strategy,
            this.usdIssuer
          );
          if (row) {
            await this.db!.run(
              `DELETE FROM transactions WHERE strategy = ? AND usd_issuer = ? AND id <= ?`,
              this.strategy,
              this.usdIssuer,
              row.id
            );
          }
        } catch (error) {
          log.error('Error al insertar transacción en SQLite:', error);
        }
      });
    }
  }

  logBalance(xrp: string, usd: string) {
    const record: BalanceRecord = {
      timestamp: new Date().toISOString(),
      xrp,
      usd
    };
    this.cache.balances.push(record);
    if (this.cache.balances.length > 500) {
      this.cache.balances.shift();
    }

    if (this.isTest) {
      this.enqueueWrite();
    } else {
      this.initPromise.then(async () => {
        try {
          await this.db!.run(
            `INSERT INTO balances (strategy, usd_issuer, timestamp, xrp, usd) VALUES (?, ?, ?, ?, ?)`,
            this.strategy,
            this.usdIssuer,
            record.timestamp,
            record.xrp,
            record.usd
          );

          const row = await this.db!.get(
            `SELECT id FROM balances WHERE strategy = ? AND usd_issuer = ? ORDER BY id DESC LIMIT 1 OFFSET 500`,
            this.strategy,
            this.usdIssuer
          );
          if (row) {
            await this.db!.run(
              `DELETE FROM balances WHERE strategy = ? AND usd_issuer = ? AND id <= ?`,
              this.strategy,
              this.usdIssuer,
              row.id
            );
          }
        } catch (error) {
          log.error('Error al insertar balance en SQLite:', error);
        }
      });
    }
  }

  getTransactions(): TransactionRecord[] {
    return this.cache.transactions;
  }

  getBalancesHistory(): BalanceRecord[] {
    return this.cache.balances;
  }

  getLastBalance(): BalanceRecord | null {
    if (this.cache.balances.length === 0) return null;
    return this.cache.balances[this.cache.balances.length - 1];
  }

  saveCustomData(key: string, value: any): void {
    this.cache.custom[key] = value;

    if (this.isTest) {
      this.enqueueWrite();
    } else {
      this.initPromise.then(async () => {
        try {
          await this.db!.run(
            `INSERT INTO custom_data (strategy, usd_issuer, key, value) VALUES (?, ?, ?, ?)
             ON CONFLICT(strategy, usd_issuer, key) DO UPDATE SET value = excluded.value`,
            this.strategy,
            this.usdIssuer,
            key,
            JSON.stringify(value)
          );
        } catch (error) {
          log.error('Error al guardar custom data en SQLite:', error);
        }
      });
    }
  }

  getCustomData(key: string): any {
    return this.cache.custom[key];
  }

  logAnomaly(type: string, message: string, details: any = {}) {
    const anomaly = {
      timestamp: new Date().toISOString(),
      type,
      message,
      details
    };
    this.cache.anomalies.push(anomaly);
    if (this.cache.anomalies.length > 100) {
      this.cache.anomalies.shift();
    }

    if (this.isTest) {
      this.enqueueWrite();
    } else {
      this.initPromise.then(async () => {
        try {
          await this.db!.run(
            `INSERT INTO anomalies (strategy, usd_issuer, timestamp, type, message, details) VALUES (?, ?, ?, ?, ?, ?)`,
            this.strategy,
            this.usdIssuer,
            anomaly.timestamp,
            anomaly.type,
            anomaly.message,
            JSON.stringify(anomaly.details)
          );

          const row = await this.db!.get(
            `SELECT id FROM anomalies WHERE strategy = ? AND usd_issuer = ? ORDER BY id DESC LIMIT 1 OFFSET 100`,
            this.strategy,
            this.usdIssuer
          );
          if (row) {
            await this.db!.run(
              `DELETE FROM anomalies WHERE strategy = ? AND usd_issuer = ? AND id <= ?`,
              this.strategy,
              this.usdIssuer,
              row.id
            );
          }
        } catch (error) {
          log.error('Error al registrar anomalía en SQLite:', error);
        }
      });
    }
  }

  getAnomalies(): any[] {
    return this.cache.anomalies;
  }

  reloadAndValidate() {
    if (this.isTest) {
      let healthy = true;
      let repaired = false;
      try {
        if (!fs.existsSync(this.dbPath)) {
          this.cache = { transactions: [], balances: [], custom: {}, anomalies: [] };
          this.enqueueWrite();
          return { healthy: false, repaired: true };
        }
        const fileContent = fs.readFileSync(this.dbPath, 'utf8');
        let parsed: any;
        try {
          parsed = JSON.parse(fileContent);
        } catch (parseErr) {
          const backupPath = this.dbPath + `.corrupt.${Date.now()}`;
          fs.copyFileSync(this.dbPath, backupPath);
          this.cache = { transactions: [], balances: [], custom: {}, anomalies: [] };
          this.enqueueWrite();
          return { healthy: false, repaired: true };
        }

        if (!parsed || typeof parsed !== 'object') {
          parsed = { transactions: [], balances: [] };
          repaired = true;
        }
        if (!Array.isArray(parsed.transactions)) {
          parsed.transactions = [];
          repaired = true;
        }
        if (!Array.isArray(parsed.balances)) {
          parsed.balances = [];
          repaired = true;
        }
        if (!parsed.custom || typeof parsed.custom !== 'object') {
          parsed.custom = {};
        }

        this.cache.transactions = parsed.transactions;
        this.cache.balances = parsed.balances;
        this.cache.custom = parsed.custom;
        this.cache.anomalies = parsed.custom.anomalies || [];

        if (repaired) {
          this.enqueueWrite();
          healthy = false;
        }
        return { healthy, repaired };
      } catch (error) {
        this.cache = { transactions: [], balances: [], custom: {}, anomalies: [] };
        this.enqueueWrite();
        return { healthy: false, repaired: true };
      }
    }
    return { healthy: true, repaired: false };
  }

  prune(txLimit = 150, balanceLimit = 300) {
    let pruned = false;
    if (this.cache.transactions.length > txLimit) {
      this.cache.transactions = this.cache.transactions.slice(-txLimit);
      pruned = true;
    }
    if (this.cache.balances.length > balanceLimit) {
      this.cache.balances = this.cache.balances.slice(-balanceLimit);
      pruned = true;
    }
    if (this.isTest) {
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const keys = Object.keys(this.cache.custom);
      for (const key of keys) {
        const val = this.cache.custom[key];
        if (val?.timestamp && new Date(val.timestamp).getTime() < sevenDaysAgo) {
          delete this.cache.custom[key];
          pruned = true;
        }
      }
    }
    if (pruned && this.isTest) {
      this.enqueueWrite();
    }
    return pruned;
  }
}

export const db = new JSONDatabase();
