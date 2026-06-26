import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';

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
    this.dbPath = path.join(dir, 'db.json');

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
    
    // Limitar historial a 100 registros
    if (this.data.balances.length > 100) {
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
}

// Instancia única (Singleton) para fácil acceso en todo el bot
export const db = new JSONDatabase();
