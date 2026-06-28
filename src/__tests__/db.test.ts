import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Tests de la clase JSONDatabase con aislamiento.
// En vez de importar el singleton, probamos la clase directamente
// creando instancias frescas sobre un directorio limpio.

// Usamos importación dinámica para evitar el singleton auto-construido
describe('JSONDatabase', () => {
  const dataDir = path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'db.json');
  let originalDbContent: string | null = null;

  beforeEach(() => {
    // Guardar copia de seguridad del archivo existente si lo hay
    if (fs.existsSync(dbPath)) {
      originalDbContent = fs.readFileSync(dbPath, 'utf8');
    }
    // Limpiar el archivo para tener estado fresco
    if (fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, JSON.stringify({ transactions: [], balances: [] }, null, 2), 'utf8');
    }
  });

  afterEach(() => {
    // Restaurar el archivo original después de los tests
    if (originalDbContent !== null && fs.existsSync(dataDir)) {
      fs.writeFileSync(dbPath, originalDbContent, 'utf8');
    }
  });

  // Función helper para crear instancia fresca
  async function createFreshDb() {
    // Limpiar el archivo
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(dbPath, JSON.stringify({ transactions: [], balances: [] }, null, 2), 'utf8');

    // Importar dinámicamente para obtener una clase fresca
    const { JSONDatabase } = await import('../db.js');
    return new JSONDatabase();
  }

  it('debe crear una instancia sin errores', async () => {
    const db = await createFreshDb();
    expect(db).toBeDefined();
  });

  it('debe registrar transacciones y recuperarlas', async () => {
    const db = await createFreshDb();
    db.logTransaction('COMPRA_LIMITE', 'hash123', 'tesSUCCESS', { price: 0.50 });

    const transactions = db.getTransactions();
    expect(transactions.length).toBeGreaterThanOrEqual(1);
    const lastTx = transactions[transactions.length - 1];
    expect(lastTx.type).toBe('COMPRA_LIMITE');
    expect(lastTx.hash).toBe('hash123');
    expect(lastTx.status).toBe('tesSUCCESS');
    expect(lastTx.detail.price).toBe(0.50);
  });

  it('debe registrar balances y recuperarlos', async () => {
    const db = await createFreshDb();
    db.logBalance('100.5', '25.0');

    const history = db.getBalancesHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    const lastBalance = history[history.length - 1];
    expect(lastBalance.xrp).toBe('100.5');
    expect(lastBalance.usd).toBe('25.0');
  });

  it('debe retornar el último balance guardado', async () => {
    const db = await createFreshDb();
    db.logBalance('50', '10');
    db.logBalance('60', '15');

    const last = db.getLastBalance();
    expect(last).not.toBeNull();
    expect(last!.xrp).toBe('60');
    expect(last!.usd).toBe('15');
  });

  it('debe respetar el límite de 200 transacciones', async () => {
    const db = await createFreshDb();

    for (let i = 0; i < 210; i++) {
      db.logTransaction('TEST', `hash_${i}`, 'tesSUCCESS');
    }

    const transactions = db.getTransactions();
    expect(transactions.length).toBeLessThanOrEqual(200);
  });

  it('debe respetar el límite de 500 balances', async () => {
    const db = await createFreshDb();

    for (let i = 0; i < 510; i++) {
      db.logBalance(`${i}`, `${i * 2}`);
    }

    const balances = db.getBalancesHistory();
    expect(balances.length).toBeLessThanOrEqual(500);
  });

  it('debe retornar null si no hay balances en instancia nueva', async () => {
    const db = await createFreshDb();
    expect(db.getLastBalance()).toBeNull();
  });

  it('debe poder guardar y recuperar datos personalizados (custom data)', async () => {
    const db = await createFreshDb();
    const testData = { rungs: [{ price: 0.55, qty: 10 }] };
    db.saveCustomData('test_key', testData);

    const retrieved = db.getCustomData('test_key');
    expect(retrieved).toEqual(testData);
  });

  describe('reloadAndValidate', () => {
    it('debe recargar correctamente un archivo válido y reportar healthy', async () => {
      const db = await createFreshDb();
      const sampleData = {
        transactions: [{ timestamp: new Date().toISOString(), type: 'BUY', hash: 'h1', status: 'tesSUCCESS', detail: {} }],
        balances: [{ timestamp: new Date().toISOString(), xrp: '10', usd: '20' }]
      };
      fs.writeFileSync(dbPath, JSON.stringify(sampleData, null, 2), 'utf8');

      const result = db.reloadAndValidate();
      expect(result.healthy).toBe(true);
      expect(result.repaired).toBe(false);
      expect(db.getTransactions().length).toBe(1);
      expect(db.getBalancesHistory().length).toBe(1);
    });

    it('debe recrear el estado si el archivo de base de datos no existe', async () => {
      const db = await createFreshDb();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }

      const result = db.reloadAndValidate();
      expect(result.healthy).toBe(false);
      expect(result.repaired).toBe(true);
      expect(db.getTransactions()).toEqual([]);
      expect(db.getBalancesHistory()).toEqual([]);
    });

    it('debe detectar JSON corrupto, respaldarlo, y recrear una DB limpia', async () => {
      const db = await createFreshDb();
      fs.writeFileSync(dbPath, 'este no es un JSON { valido }', 'utf8');

      const result = db.reloadAndValidate();
      expect(result.healthy).toBe(false);
      expect(result.repaired).toBe(true);
      expect(db.getTransactions()).toEqual([]);

      // Verificar que se creó un archivo .corrupt
      const files = fs.readdirSync(dataDir);
      const corruptBackup = files.find(f => f.startsWith('db.json.corrupt.'));
      expect(corruptBackup).toBeDefined();

      // Limpiar archivo backup corrupto de prueba
      if (corruptBackup) {
        fs.unlinkSync(path.join(dataDir, corruptBackup));
      }
    });

    it('debe reparar campos faltantes o inválidos', async () => {
      const db = await createFreshDb();
      fs.writeFileSync(dbPath, JSON.stringify({ transactions: 'no es un array', custom: {} }), 'utf8');

      const result = db.reloadAndValidate();
      expect(result.healthy).toBe(false);
      expect(result.repaired).toBe(true);
      expect(db.getTransactions()).toEqual([]);
      expect(db.getBalancesHistory()).toEqual([]);
    });
  });

  describe('prune', () => {
    it('debe podar transacciones y balances a los límites indicados', async () => {
      const db = await createFreshDb();

      // Agregar datos por encima de los límites de poda
      for (let i = 0; i < 20; i++) {
        db.logTransaction('TX', `h${i}`, 'tesSUCCESS');
        db.logBalance(`${i}`, `${i}`);
      }

      // Podar a 5 transacciones y 10 balances
      const pruned = db.prune(5, 10);
      expect(pruned).toBe(true);
      expect(db.getTransactions().length).toBe(5);
      expect(db.getBalancesHistory().length).toBe(10);
      // Deben quedar los últimos
      expect(db.getTransactions()[0].hash).toBe('h15');
      expect(db.getBalancesHistory()[0].xrp).toBe('10');
    });

    it('debe podar datos personalizados (custom) viejos (>7 días)', async () => {
      const db = await createFreshDb();

      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const newTimestamp = new Date().toISOString();

      db.saveCustomData('old_key', { timestamp: oldTimestamp, value: 'old' });
      db.saveCustomData('new_key', { timestamp: newTimestamp, value: 'new' });

      const pruned = db.prune(150, 300);
      expect(pruned).toBe(true);
      expect(db.getCustomData('old_key')).toBeUndefined();
      expect(db.getCustomData('new_key')).toBeDefined();
    });
  });
});
