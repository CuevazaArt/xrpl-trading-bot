import { Client, Wallet } from 'xrpl';
import { createLogger } from './logger.js';

const log = createLogger('WalletManager');

export class XRPLWalletManager {
  private client: Client;
  private wallet: Wallet | null = null;

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
      log.warn('[SEGURIDAD] Seed generado. Consulta el archivo .env para configurarlo. NO se imprime en logs por seguridad.');

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
}
