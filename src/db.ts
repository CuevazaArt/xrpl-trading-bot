import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
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
  private data: {
    transactions: TransactionRecord[];
    balances: BalanceRecord[];
    custom?: Record<string, any>;
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    // Definir la ruta en el directorio del proyecto
    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const strategy = config.strategy || 'unknown';
    const issuer = config.usdIssuer || 'default';
    const isTest = process.env.NODE_ENV === 'test';
    this.dbPath = isTest ? path.join(dir, 'db.json') : path.join(dir, `db_${strategy}_${issuer}.json`);

    // Inicializar los datos (lectura síncrona solo en el arranque)
    if (fs.existsSync(this.dbPath)) {
      try {
        const fileContent = fs.readFileSync(this.dbPath, 'utf8');
        this.data = JSON.parse(fileContent);
      } catch (error) {
        log.error('Error al cargar la base de datos JSON. Reinicializando...');
        this.data = { transactions: [], balances: [] };
      }
    } else {
      this.data = { transactions: [], balances: [] };
      this.enqueueWrite();
    }
  }

  /**
   * Escritura atómica: escribe a un archivo temporal y luego renombra.
   * Las escrituras se encolan para evitar condiciones de carrera.
   */
  private enqueueWrite() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmpPath = this.dbPath + '.tmp';
      try {
        await fsp.writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
        await fsp.rename(tmpPath, this.dbPath);
      } catch (error) {
        log.error('Error al escribir en la base de datos JSON:', error);
        // Intentar limpieza del temporal
        try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
      }
    });
  }

  /**
   * Registra una transacción en el historial.
   */
  logTransaction(type: string, hash: string, status: string, detail: any = {}) {
    const record: TransactionRecord = {
      timestamp: new Date().toISOString(),
      type,
      hash,
      status,
      detail
    };
    this.data.transactions.push(record);
    
    // Mantener un límite de 200 registros de logs
    if (this.data.transactions.length > 200) {
      this.data.transactions.shift();
    }
    this.enqueueWrite();
  }

  /**
   * Guarda un registro de balance histórico.
   */
  logBalance(xrp: string, usd: string) {
    const record: BalanceRecord = {
      timestamp: new Date().toISOString(),
      xrp,
      usd
    };
    this.data.balances.push(record);
    
    // Limitar historial a 500 registros para evitar crecimiento descontrolado del archivo
    if (this.data.balances.length > 500) {
      this.data.balances.shift();
    }
    this.enqueueWrite();
  }

  /**
   * Devuelve las transacciones registradas.
   */
  getTransactions(): TransactionRecord[] {
    return this.data.transactions;
  }

  /**
   * Devuelve el historial de balances.
   */
  getBalancesHistory(): BalanceRecord[] {
    return this.data.balances;
  }

  /**
   * Devuelve el último balance guardado.
   */
  getLastBalance(): BalanceRecord | null {
    if (this.data.balances.length === 0) return null;
    return this.data.balances[this.data.balances.length - 1];
  }

  /**
   * Guarda cualquier dato personalizado en la DB local
   */
  saveCustomData(key: string, value: any): void {
    if (!this.data.custom) {
      this.data.custom = {};
    }
    this.data.custom[key] = value;
    this.enqueueWrite();
  }

  /**
   * Recupera cualquier dato personalizado desde la DB local
   */
  getCustomData(key: string): any {
    return this.data.custom ? this.data.custom[key] : undefined;
  }

  /**
   * Registra una anomalía operativa depurada en la DB local.
   */
  logAnomaly(type: string, message: string, details: any = {}) {
    if (!this.data.custom) {
      this.data.custom = {};
    }
    if (!Array.isArray(this.data.custom.anomalies)) {
      this.data.custom.anomalies = [];
    }
    this.data.custom.anomalies.push({
      timestamp: new Date().toISOString(),
      type,
      message,
      details
    });
    
    // Limitar historial a 100 registros para evitar sobrecarga
    if (this.data.custom.anomalies.length > 100) {
      this.data.custom.anomalies.shift();
    }
    this.enqueueWrite();
  }

  /**
   * Obtiene la lista de anomalías registradas.
   */
  getAnomalies(): any[] {
    return this.data.custom && Array.isArray(this.data.custom.anomalies) ? this.data.custom.anomalies : [];
  }

  /**
   * Fuerza la recarga de datos desde el disco, validando su estructura.
   * Si el archivo no existe o está corrupto, lo inicializa y lo guarda.
   */
  reloadAndValidate(): { healthy: boolean; repaired: boolean } {
    let healthy = true;
    let repaired = false;

    try {
      if (!fs.existsSync(this.dbPath)) {
        this.data = { transactions: [], balances: [] };
        this.enqueueWrite();
        return { healthy: false, repaired: true };
      }

      const fileContent = fs.readFileSync(this.dbPath, 'utf8');
      let parsed: any;
      try {
        parsed = JSON.parse(fileContent);
      } catch (parseErr) {
        log.error('Error al parsear el JSON de la base de datos. Re-inicializando...');
        // Hacer backup del archivo corrupto
        const backupPath = this.dbPath + `.corrupt.${Date.now()}`;
        fs.copyFileSync(this.dbPath, backupPath);
        this.data = { transactions: [], balances: [] };
        this.enqueueWrite();
        return { healthy: false, repaired: true };
      }

      if (!parsed || typeof parsed !== 'object') {
        parsed = { transactions: [], balances: [] };
        repaired = true;
      }

      // Validar y reparar campos in-memory
      if (!Array.isArray(parsed.transactions)) {
        parsed.transactions = [];
        repaired = true;
      }
      if (!Array.isArray(parsed.balances)) {
        parsed.balances = [];
        repaired = true;
      }

      // Limpiar transacciones corruptas
      const corruptTxCount = parsed.transactions.filter((t: any) => !t.timestamp || !t.type).length;
      if (corruptTxCount > 0) {
        parsed.transactions = parsed.transactions.filter((t: any) => t.timestamp && t.type);
        repaired = true;
      }

      this.data = parsed;
      if (repaired) {
        this.enqueueWrite();
        healthy = false;
      }
      return { healthy, repaired };
    } catch (error) {
      log.error('Error al recargar y validar la base de datos desde el disco:', error);
      this.data = { transactions: [], balances: [] };
      this.enqueueWrite();
      return { healthy: false, repaired: true };
    }
  }

  /**
   * Poda los datos de forma segura en memoria y encola la escritura en disco.
   */
  prune(txLimit = 150, balanceLimit = 300): boolean {
    let pruned = false;

    if (this.data.transactions && this.data.transactions.length > txLimit) {
      this.data.transactions = this.data.transactions.slice(-txLimit);
      pruned = true;
    }

    if (this.data.balances && this.data.balances.length > balanceLimit) {
      this.data.balances = this.data.balances.slice(-balanceLimit);
      pruned = true;
    }

    if (this.data.custom) {
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const keys = Object.keys(this.data.custom);
      for (const key of keys) {
        const val = this.data.custom[key];
        if (val?.timestamp && new Date(val.timestamp).getTime() < sevenDaysAgo) {
          delete this.data.custom[key];
          pruned = true;
        }
      }
    }

    if (pruned) {
      this.enqueueWrite();
    }
    return pruned;
  }
}

// Instancia única (Singleton) para fácil acceso en todo el bot
export const db = new JSONDatabase();
