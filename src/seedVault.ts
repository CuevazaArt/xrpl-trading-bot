import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createLogger } from './logger.js';

const log = createLogger('SeedVault');

// =====================================================================
// AES-256-GCM Encryption for XRPL wallet seeds
// =====================================================================

const VAULT_FILE = path.join(process.cwd(), 'data', 'seed.vault');
const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_ITERATIONS = 100_000;

interface VaultData {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Deriva una clave AES-256 desde un password usando PBKDF2.
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, KEY_ITERATIONS, 32, 'sha256');
}

/**
 * Cifra un seed con AES-256-GCM.
 */
function encrypt(seed: string, password: string): VaultData {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { salt, iv, tag, ciphertext: encrypted };
}

/**
 * Descifra un vault con AES-256-GCM.
 */
function decrypt(vault: VaultData, password: string): string {
  const key = deriveKey(password, vault.salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, vault.iv);
  decipher.setAuthTag(vault.tag);

  const decrypted = Buffer.concat([decipher.update(vault.ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Guarda el vault cifrado en disco.
 * Formato: [32 bytes salt][16 bytes IV][16 bytes tag][N bytes ciphertext]
 */
function saveVault(vault: VaultData): void {
  const dir = path.dirname(VAULT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const buffer = Buffer.concat([vault.salt, vault.iv, vault.tag, vault.ciphertext]);
  fs.writeFileSync(VAULT_FILE, buffer);
}

/**
 * Lee el vault desde disco.
 */
function loadVault(): VaultData {
  const buffer = fs.readFileSync(VAULT_FILE);

  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  return { salt, iv, tag, ciphertext };
}

/**
 * Pregunta interactivamente por un input (oculto si es password).
 */
function askQuestion(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// =====================================================================
// API PÚBLICA
// =====================================================================

/**
 * Verifica si existe un vault cifrado.
 */
export function vaultExists(): boolean {
  return fs.existsSync(VAULT_FILE);
}

/**
 * Intenta obtener el seed:
 * 1. Si existe vault → descifrar con password (env o interactivo)
 * 2. Si no → retornar null (el caller usará .env como fallback)
 */
export async function getSeedFromVault(): Promise<string | null> {
  if (!vaultExists()) {
    return null;
  }

  log.info('🔐 Vault cifrado detectado. Descifrando seed...');

  // Intentar password desde variable de entorno primero
  const envPassword = process.env.VAULT_PASSWORD;
  if (envPassword) {
    try {
      const vault = loadVault();
      const seed = decrypt(vault, envPassword);
      log.info('🔓 Seed descifrado exitosamente desde VAULT_PASSWORD.');
      return seed;
    } catch {
      log.warn('VAULT_PASSWORD incorrecta. Pidiendo por terminal...');
    }
  }

  // Fallback: pedir por terminal interactiva
  if (process.stdin.isTTY) {
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
      const password = await askQuestion(`🔑 Ingresa el password del vault (intento ${i + 1}/${maxAttempts}): `);
      try {
        const vault = loadVault();
        const seed = decrypt(vault, password);
        log.info('🔓 Seed descifrado exitosamente.');
        return seed;
      } catch {
        log.warn('Password incorrecto. Intenta de nuevo.');
      }
    }
    log.error('Demasiados intentos fallidos. No se pudo descifrar el vault.');
    return null;
  }

  log.error('No hay VAULT_PASSWORD y no es terminal interactiva. No se puede descifrar el vault.');
  return null;
}

// =====================================================================
// CLI: npm run vault:encrypt
// =====================================================================

async function cliEncrypt() {
  console.log('═══════════════════════════════════════════');
  console.log('  Helena — Seed Vault Encryption');
  console.log('═══════════════════════════════════════════');
  console.log('');

  const seed = await askQuestion('Ingresa tu XRPL wallet seed (sXXX...): ');
  if (!seed || seed.length < 20) {
    console.error('❌ Seed inválido. Debe tener al menos 20 caracteres.');
    process.exit(1);
  }

  const password = await askQuestion('Crea un password para cifrar el seed: ');
  if (!password || password.length < 6) {
    console.error('❌ Password debe tener al menos 6 caracteres.');
    process.exit(1);
  }

  const confirm = await askQuestion('Confirma el password: ');
  if (password !== confirm) {
    console.error('❌ Los passwords no coinciden.');
    process.exit(1);
  }

  const vault = encrypt(seed, password);
  saveVault(vault);

  console.log('');
  console.log(`✅ Seed cifrado y guardado en: ${VAULT_FILE}`);
  console.log('');
  console.log('Próximos pasos:');
  console.log('  1. Elimina XRPL_WALLET_SEED de tu .env');
  console.log('  2. Al arrancar Helena, te pedirá el password');
  console.log('  3. O configura VAULT_PASSWORD en .env para modo automático');
  console.log('');
  console.log('⚠️  RESPALDO: Guarda tu seed en un lugar seguro offline.');
  console.log('    Si pierdes el password Y el seed original, perderás acceso a tus fondos.');

  process.exit(0);
}

// Ejecutar CLI si se llama directamente
const args = process.argv.slice(2);
if (args[0] === 'encrypt') {
  cliEncrypt();
}
