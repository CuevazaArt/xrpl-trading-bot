import fs from 'fs';
import path from 'path';

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
  };

  constructor() {
    // Definir la ruta en el directorio del proyecto
    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dbPath = path.join(dir, 'db.json');

    // Inicializar los datos
    if (fs.existsSync(this.dbPath)) {
      try {
        const fileContent = fs.readFileSync(this.dbPath, 'utf8');
        this.data = JSON.parse(fileContent);
      } catch (error) {
        console.error('Error al cargar la base de datos JSON. Reinicializando...');
        this.data = { transactions: [], balances: [] };
      }
    } else {
      this.data = { transactions: [], balances: [] };
      this.saveToFile();
    }
  }

  private saveToFile() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      console.error('Error al escribir en la base de datos JSON:', error);
    }
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
    this.saveToFile();
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
    this.saveToFile();
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
}

// Instancia única (Singleton) para fácil acceso en todo el bot
export const db = new JSONDatabase();
