import { Client, Wallet } from 'xrpl';
import { createLogger } from './logger.js';
import { saveToEnv } from './utils.js';
import { config } from './config.js';
import { IWalletProviderAdapter } from './walletAdapters/IWalletProviderAdapter.js';
import { EOAWalletAdapter } from './walletAdapters/eoaWalletAdapter.js';
import { MockWalletAdapter } from './walletAdapters/mockWalletAdapter.js';
import { SafeWalletAdapter } from './walletAdapters/safeWalletAdapter.js';

const log = createLogger('WalletManager');

// Cache para server_info — la reserva base cambia muy raramente
const SERVER_INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutos

interface ServerInfoCache {
  baseReserveXrp: number;
  ownerReserveXrp: number;
  fetchedAt: number;
}

export class XRPLWalletManager {
  private client: Client;
  private serverInfoCache: ServerInfoCache | null = null;
  private activeAdapter: IWalletProviderAdapter;

  constructor(client: Client, adapter?: IWalletProviderAdapter) {
    this.client = client;
    
    // Si no se inyecta adaptador, decidimos según la configuración
    if (adapter) {
      this.activeAdapter = adapter;
    } else {
      const providerType = (process.env.WALLET_PROVIDER || 'eoa').toLowerCase();
      if (providerType === 'mock') {
        this.activeAdapter = new MockWalletAdapter();
      } else if (providerType === 'safe') {
        this.activeAdapter = new SafeWalletAdapter();
      } else {
        // Por defecto cargamos EOA (billetera local con seed)
        this.activeAdapter = new EOAWalletAdapter(client, config.walletSeed);
      }
    }
    log.info(`Proveedor de billeteras cargado: '${this.activeAdapter.providerId}'`);
  }

  /**
   * Inicializa la billetera cargándola mediante el adaptador configurado.
   */
  async initializeWallet(seed: string | null) {
    // Si el adaptador es de tipo EOA y tenemos un seed nuevo, lo reconfiguramos
    if (this.activeAdapter instanceof EOAWalletAdapter && seed) {
      this.activeAdapter = new EOAWalletAdapter(this.client, seed);
    }
    
    await this.activeAdapter.initialize();

    // Lógica para guardar la semilla generada de forma local si es EOA nueva
    if (this.activeAdapter instanceof EOAWalletAdapter) {
      const wallet = this.activeAdapter.getUnderlyingWallet();
      if (wallet && !seed && wallet.seed) {
        try {
          saveToEnv('XRPL_WALLET_SEED', wallet.seed);
          log.info('¡Semilla guardada automáticamente en el archivo .env!');
        } catch (err) {
          log.error('Error al guardar la semilla generada en .env:', err);
        }
      }
    }
  }

  /**
   * Obtiene el balance de XRP de la cuenta.
   */
  async getXrpBalance(): Promise<string> {
    try {
      const balances = await this.activeAdapter.getBalances();
      return String(balances.xrp);
    } catch (error) {
      log.error('Error al obtener balance de XRP:', error);
      return '0';
    }
  }

  /**
   * Obtiene las líneas de confianza (Trustlines) e IOUs (Tokens)
   */
  async getTokensBalances() {
    try {
      const address = await this.activeAdapter.getAddress();
      const response = await this.client.request({
        command: 'account_lines',
        account: address,
      });

      const lines = response.result.lines || [];
      return lines.map((line: any) => ({
        currency: line.currency,
        balance: line.balance,
        issuer: line.account,
        limit: line.limit,
      }));
    } catch (error: any) {
      if (error.data && error.data.error === 'actNotFound') {
        return [];
      }
      // Si el adaptador no está en el ledger principal, retornamos el valor en memoria para Mock
      if (this.activeAdapter instanceof MockWalletAdapter) {
        const bals = await this.activeAdapter.getBalances();
        return [{ currency: 'USD', balance: String(bals.usd), issuer: config.usdIssuer, limit: '1000000' }];
      }
      log.error('Error al consultar líneas de confianza:', error);
      return [];
    }
  }

  /**
   * Devuelve la billetera actual (solo para compatibilidad con EOA en los flujos principales).
   */
  getWallet(): Wallet | null {
    if (this.activeAdapter instanceof EOAWalletAdapter) {
      return this.activeAdapter.getUnderlyingWallet();
    }
    // Para adaptadores no-EOA, retornamos un wrapper simulado compatible con firma básica
    const mockAddr = 'rMOCKWALLETXXXXXXXXXXXXXXX';
    return {
      address: mockAddr,
      publicKey: 'MOCK_PUB_KEY',
      privateKey: 'MOCK_PRIV_KEY',
      sign: () => ({ tx_blob: '', hash: '' })
    } as any;
  }

  /**
   * Establece manualmente la billetera activa (para retro-compatibilidad).
   */
  setWallet(wallet: Wallet) {
    this.activeAdapter = new EOAWalletAdapter(this.client, wallet.seed || null);
    (this.activeAdapter as EOAWalletAdapter).initialize().then(() => {
      (this.activeAdapter as any).wallet = wallet;
    });
  }

  /**
   * Verifica si el balance de XRP es suficiente para cubrir la reserva requerida.
   */
  async hasEnoughReserve(): Promise<boolean> {
    try {
      const address = await this.activeAdapter.getAddress();
      const { baseReserveXrp, ownerReserveXrp } = await this.getServerReserveInfo();

      let ownerCount = 0;
      try {
        const response = await this.client.request({
          command: 'account_info',
          account: address,
          ledger_index: 'validated'
        });
        ownerCount = response.result.account_data.OwnerCount || 0;
      } catch (error: any) {
        if (error.data && error.data.error === 'actNotFound') {
          return false;
        }
      }

      const officialReserve = baseReserveXrp + (ownerReserveXrp * ownerCount);
      const totalRequiredReserve = officialReserve + config.minXrpReserveBuffer;

      const balanceXrpStr = await this.getXrpBalance();
      const currentBalance = parseFloat(balanceXrpStr);

      if (isNaN(currentBalance)) {
        return false;
      }

      if (currentBalance < totalRequiredReserve) {
        log.warn(`ALERTA: Saldo XRP (${currentBalance.toFixed(4)}) < Reserva requerida (${totalRequiredReserve.toFixed(4)} XRP) [base=${baseReserveXrp}, owner=${ownerReserveXrp}×${ownerCount}=${ownerReserveXrp * ownerCount}, buffer=${config.minXrpReserveBuffer}]`);
        return false;
      }

      return true;
    } catch (error) {
      log.error('Error al verificar la reserva de XRP:', error);
      return false;
    }
  }

  /**
   * Obtiene los parámetros de reserva del servidor.
   */
  private async getServerReserveInfo(): Promise<{ baseReserveXrp: number; ownerReserveXrp: number }> {
    const now = Date.now();

    if (this.serverInfoCache && (now - this.serverInfoCache.fetchedAt) < SERVER_INFO_CACHE_TTL_MS) {
      return {
        baseReserveXrp: this.serverInfoCache.baseReserveXrp,
        ownerReserveXrp: this.serverInfoCache.ownerReserveXrp,
      };
    }

    try {
      const serverInfo = await this.client.request({ command: 'server_info' });
      const validatedLedger = serverInfo.result.info.validated_ledger;
      const baseReserveXrp = validatedLedger?.reserve_base_xrp ?? 10;
      const ownerReserveXrp = validatedLedger?.reserve_inc_xrp ?? 2;

      this.serverInfoCache = { baseReserveXrp, ownerReserveXrp, fetchedAt: now };
      return { baseReserveXrp, ownerReserveXrp };
    } catch {
      return { baseReserveXrp: 10, ownerReserveXrp: 2 };
    }
  }

  /**
   * Devuelve el adaptador activo.
   */
  getActiveAdapter(): IWalletProviderAdapter {
    return this.activeAdapter;
  }
}
