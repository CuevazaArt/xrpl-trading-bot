import { Client, Wallet } from 'xrpl';
import { createLogger } from './logger.js';
import { saveToEnv } from './utils.js';
import { config } from './config.js';

const log = createLogger('WalletManager');

// Cache para server_info — la reserva base cambia cada meses
const SERVER_INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutos

interface ServerInfoCache {
  baseReserveXrp: number;
  ownerReserveXrp: number;
  fetchedAt: number;
}


export class XRPLWalletManager {
  private client: Client;
  private wallet: Wallet | null = null;
  private serverInfoCache: ServerInfoCache | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Inicializa la billetera cargándola desde el seed provisto,
   * o generando una nueva billetera de forma local.
   * Si estamos en Testnet y es una cuenta nueva, intenta fondearla.
   */
  async initializeWallet(seed: string | null) {
    if (seed) {
      log.info('Cargando billetera existente desde la semilla (seed) provista...');
      try {
        this.wallet = Wallet.fromSeed(seed);
        log.info(`Billetera cargada exitosamente: ${this.wallet.address}`);

        // Verificar si la cuenta está activa en Testnet; de lo contrario, fondearla
        const url = this.client.connection.getUrl();
        const isTestnet = url.includes('testnet') || url.includes('devnet') || url.includes('rippletest') || url.includes('altnet');
        if (isTestnet) {
          try {
            await this.client.getXrpBalance(this.wallet.address);
          } catch (error: any) {
            if (error.data && error.data.error === 'actNotFound') {
              log.info('La cuenta cargada no existe en la Testnet. Solicitando activación y fondeo al Faucet...');
              const fundResult = await this.client.fundWallet(this.wallet);
              this.wallet = fundResult.wallet;
              log.info(`¡Fondeo de cuenta exitoso! Saldo acreditado: ${fundResult.balance} XRP.`);
            }
          }
        }
      } catch (error) {
        log.error('Error al cargar la billetera desde la semilla:', error);
        throw error;
      }
    } else {
      log.info('No se detectó semilla en las variables de entorno. Generando una nueva billetera local...');
      this.wallet = Wallet.generate();
      log.info(`Nueva billetera generada localmente.`);
      log.info(`Dirección pública: ${this.wallet.address}`);
      log.info(`Clave semilla (SEED): ${this.wallet.seed}`);
      
      try {
        if (this.wallet.seed) {
          saveToEnv('XRPL_WALLET_SEED', this.wallet.seed);
          log.info('¡Semilla guardada automáticamente en el archivo .env!');
        }
      } catch (err) {
        log.error('Error al guardar la semilla generada en .env:', err);
      }

      log.warn(`[SEGURIDAD] Guarda esta semilla en un lugar seguro para producción.`);


      // Si la red es de pruebas (Testnet/Devnet), solicitamos fondeo automático al Faucet
      const url = this.client.connection.getUrl();
      const isTestnet = url.includes('testnet') || url.includes('devnet') || url.includes('rippletest') || url.includes('altnet');
      if (isTestnet) {
        log.info('Detectada red de pruebas. Solicitando fondos al Faucet de XRPL...');
        try {
          // El método fundWallet conecta con el faucet, crea/activa la cuenta y la fondea con XRP
          const fundResult = await this.client.fundWallet(this.wallet);
          this.wallet = fundResult.wallet;
          log.info(`¡Fondeo de cuenta exitoso! Saldo acreditado: ${fundResult.balance} XRP.`);
        } catch (error) {
          log.error('Error al intentar fondear la cuenta con el Faucet:', error);
          log.warn('Es posible que debas fondear esta billetera manualmente.');
        }
      } else {
        log.info('Red principal detectada o nodo local. Se requiere activar la billetera transfiriendo al menos 10 XRP.');
      }
    }
  }

  /**
   * Obtiene el balance de XRP de la cuenta.
   */
  async getXrpBalance(): Promise<string> {
    if (!this.wallet) {
      throw new Error('Billetera no inicializada.');
    }
    try {
      const balance = await this.client.getXrpBalance(this.wallet.address);
      return String(balance);
    } catch (error: any) {
      if (error.data && error.data.error === 'actNotFound') {
        return '0 (Cuenta no activada/no encontrada en la red)';
      }
      log.error(`Error al obtener balance de XRP para ${this.wallet.address}:`, error);
      throw error;
    }
  }

  /**
   * Obtiene las líneas de confianza (Trustlines) e IOUs (Tokens)
   */
  async getTokensBalances() {
    if (!this.wallet) {
      throw new Error('Billetera no inicializada.');
    }
    try {
      const response = await this.client.request({
        command: 'account_lines',
        account: this.wallet.address,
      });

      const lines = response.result.lines;
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
      log.error(`Error al consultar líneas de confianza para ${this.wallet.address}:`, error);
      throw error;
    }
  }

  /**
   * Devuelve la billetera actual.
   */
  getWallet(): Wallet | null {
    return this.wallet;
  }

  /**
   * Establece manualmente la billetera activa.
   */
  setWallet(wallet: Wallet) {
    this.wallet = wallet;
  }

  /**
   * Verifica si el balance de XRP es suficiente para cubrir la reserva requerida por la red
   * (10 XRP de base + 2 XRP por objeto) más el buffer de seguridad configurado.
   * 
   * server_info se cachea con TTL de 60 min para evitar ~240 RPCs/min innecesarios.
   * La reserva base de XRPL cambia cada meses; no necesitamos consultarla en cada tick.
   */
  async hasEnoughReserve(): Promise<boolean> {
    if (!this.wallet) {
      throw new Error('Billetera no inicializada.');
    }
    try {
      // 1. Obtener la reserva del servidor (cacheada con TTL de 60 min)
      const { baseReserveXrp, ownerReserveXrp } = await this.getServerReserveInfo();

      // 2. Obtener OwnerCount de la cuenta
      const response = await this.client.request({
        command: 'account_info',
        account: this.wallet.address,
        ledger_index: 'validated'
      });

      const ownerCount = response.result.account_data.OwnerCount || 0;
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
    } catch (error: any) {
      if (error.data && error.data.error === 'actNotFound') {
        return false;
      }
      log.error('Error al verificar la reserva de XRP de la cuenta:', error);
      return false;
    }
  }

  /**
   * Obtiene los parámetros de reserva del servidor, usando caché con TTL de 60 min.
   * La reserva base de XRPL (actualmente 1 XRP base + 0.2 XRP/objeto) cambia
   * muy raramente — no tiene sentido consultar server_info en cada tick.
   */
  private async getServerReserveInfo(): Promise<{ baseReserveXrp: number; ownerReserveXrp: number }> {
    const now = Date.now();

    // Retornar desde caché si válido
    if (this.serverInfoCache && (now - this.serverInfoCache.fetchedAt) < SERVER_INFO_CACHE_TTL_MS) {
      return {
        baseReserveXrp: this.serverInfoCache.baseReserveXrp,
        ownerReserveXrp: this.serverInfoCache.ownerReserveXrp,
      };
    }

    // Fetch fresco
    const serverInfo = await this.client.request({ command: 'server_info' });
    const validatedLedger = serverInfo.result.info.validated_ledger;
    const baseReserveXrp = validatedLedger?.reserve_base_xrp ?? 10;
    const ownerReserveXrp = validatedLedger?.reserve_inc_xrp ?? 2;

    this.serverInfoCache = { baseReserveXrp, ownerReserveXrp, fetchedAt: now };
    log.debug(`server_info cacheado: base_reserve=${baseReserveXrp} XRP, owner_reserve=${ownerReserveXrp} XRP (TTL: 60min)`);

    return { baseReserveXrp, ownerReserveXrp };
  }
}
