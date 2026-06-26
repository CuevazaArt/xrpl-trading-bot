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

  it('debe respetar el límite de 100 balances', async () => {
    const db = await createFreshDb();

    for (let i = 0; i < 110; i++) {
      db.logBalance(`${i}`, `${i * 2}`);
    }

    const balances = db.getBalancesHistory();
    expect(balances.length).toBeLessThanOrEqual(100);
  });

  it('debe retornar null si no hay balances en instancia nueva', async () => {
    const db = await createFreshDb();
    expect(db.getLastBalance()).toBeNull();
  });
});
