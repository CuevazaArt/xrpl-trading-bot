import { Client, Wallet } from 'xrpl';

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
      console.log('Cargando billetera existente desde la semilla (seed) provista...');
      try {
        this.wallet = Wallet.fromSeed(seed);
        console.log(`Billetera cargada exitosamente: ${this.wallet.address}`);
      } catch (error) {
        console.error('Error al cargar la billetera desde la semilla:', error);
        throw error;
      }
    } else {
      console.log('No se detectó semilla en las variables de entorno. Generando una nueva billetera local...');
      this.wallet = Wallet.generate();
      console.log(`Nueva billetera generada localmente:`);
      console.log(`Dirección pública: ${this.wallet.address}`);
      console.log(`Clave semilla (SEED): ${this.wallet.seed}`);
      console.log(`[IMPORTANTE]: Guarda esta semilla en un lugar seguro para producción.`);

      // Si la red es de pruebas (Testnet/Devnet), solicitamos fondeo automático al Faucet
      const url = this.client.connection.getUrl();
      const isTestnet = url.includes('testnet') || url.includes('devnet') || url.includes('rippletest') || url.includes('altnet');
      if (isTestnet) {
        console.log('Detectada red de pruebas. Solicitando 10,000 XRP de fondos gratis al Faucet de XRPL...');
        try {
          // El método fundWallet conecta con el faucet, crea/activa la cuenta y la fondea con XRP
          const fundResult = await this.client.fundWallet(this.wallet);
          this.wallet = fundResult.wallet;
          console.log(`¡Fondeo de cuenta exitoso! Saldo acreditado: ${fundResult.balance} XRP.`);
        } catch (error) {
          console.error('Error al intentar fondear la cuenta con el Faucet:', error);
          console.warn('Es posible que debas fondear esta billetera manualmente.');
        }
      } else {
        console.log('Red principal detectada o nodo local. Se requiere activar la billetera transfiriendo al menos 10 XRP.');
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
      return balance;
    } catch (error: any) {
      if (error.data && error.data.error === 'actNotFound') {
        return '0 (Cuenta no activada/no encontrada en la red)';
      }
      console.error(`Error al obtener balance de XRP para ${this.wallet.address}:`, error);
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
      console.error(`Error al consultar líneas de confianza para ${this.wallet.address}:`, error);
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
