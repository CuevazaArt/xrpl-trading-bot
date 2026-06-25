import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno
dotenv.config();

export const config = {
  xrplWsUrl: process.env.XRPL_WS_URL || 'wss://s.altnet.rippletest.net:51233',
  walletSeed: process.env.XRPL_WALLET_SEED || null,
};

// Validación básica
if (!config.xrplWsUrl) {
  console.warn("ADVERTENCIA: XRPL_WS_URL no está definido en el archivo .env. Usando Testnet por defecto.");
}
