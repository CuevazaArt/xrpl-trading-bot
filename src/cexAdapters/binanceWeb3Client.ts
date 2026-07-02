import crypto from 'crypto';
import { ethers } from 'ethers';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('BinanceWeb3Client');

export interface Web3QuoteResponse {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  estimatedGas: string;
  priceImpact: string;
  routes: any[];
}

export interface Web3SwapTxResponse {
  to: string;
  data: string;
  value: string;
  estimatedGas: string;
  chainId: string;
}

// Configuración de nodos RPC públicos para transmisión (Broadcast) directa a la Blockchain
const DEFAULT_RPC_URLS: Record<string, string> = {
  '56': 'https://bsc-dataseed.binance.org', // BNB Smart Chain
  '8453': 'https://mainnet.base.org',       // Base
  'solana': 'https://api.mainnet-beta.solana.com' // Solana Mainnet
};

export class BinanceWeb3Client {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl = 'https://web3.binance.com';

  constructor() {
    this.apiKey = config.binanceWeb3ApiKey;
    this.apiSecret = config.binanceWeb3ApiSecret;
  }

  public isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  /**
   * Ejecuta peticiones HTTP firmadas con el formato X-OC-SIGN para la API Web3 de Binance.
   */
  private async request(method: 'GET' | 'POST', path: string, bodyObj?: any): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('[BinanceWeb3Client] Credenciales Web3 no configuradas en el archivo .env.');
    }

    const timestamp = new Date().toISOString(); // Formato ISO 8601 UTC requerido (e.g. 2026-05-11T10:08:57.715Z)
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyStr = bodyObj && method === 'POST' ? JSON.stringify(bodyObj) : '';

    // El preHash concatena: timestamp + método + path (incluyendo query params) + body
    const preHash = timestamp + method + path + bodyStr;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(preHash)
      .digest('base64');

    const headers: Record<string, string> = {
      'X-OC-APIKEY': this.apiKey,
      'X-OC-SIGN': signature,
      'X-OC-TIMESTAMP': timestamp,
      'X-OC-NONCE': nonce,
      'Accept': 'application/json'
    };

    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? bodyStr : undefined
      });

      const resJson = await response.json() as any;

      if (!response.ok || (resJson && resJson.code !== 0)) {
        const errMsg = resJson?.msg || `HTTP Error ${response.status}`;
        const errCode = resJson?.code || response.status;
        throw new Error(`[BinanceWeb3API_Error_${errCode}] ${errMsg}`);
      }

      return resJson.data;
    } catch (err: any) {
      log.error(`Fallo en llamada Web3 API [${method} ${path}]: ${err.message}`);
      throw err;
    }
  }

  /**
   * Obtiene la cotización del swap DeFi cruzando agregadores en caliente.
   */
  public async getQuote(
    fromToken: string,
    toToken: string,
    amount: string,
    chainId: string,
    slippage: number = 0.5
  ): Promise<Web3QuoteResponse> {
    // ChainId: '56' (BSC), '8453' (Base), 'solana'
    const query = `?fromToken=${fromToken}&toToken=${toToken}&amount=${amount}&chainId=${chainId}&slippage=${slippage}`;
    return this.request('GET', `/api/v1/dex/aggregator/quote${query}`);
  }

  /**
   * Obtiene la transacción sin firmar (payload) para ejecutar el Swap DeFi.
   */
  public async buildSwapTx(
    fromToken: string,
    toToken: string,
    amount: string,
    walletAddress: string,
    chainId: string,
    slippage: number = 0.5
  ): Promise<any> {
    const query = `?fromToken=${fromToken}&toToken=${toToken}&amount=${amount}&walletAddress=${walletAddress}&chainId=${chainId}&slippage=${slippage}`;
    return this.request('GET', `/api/v1/dex/aggregator/swap${query}`);
  }

  /**
   * Obtiene el precio on-chain actual de un token Alpha en DeFi.
   */
  public async getTokenPrice(tokenAddress: string, chainId: string): Promise<number> {
    const payload = {
      tokens: [tokenAddress],
      chainId
    };
    const data = await this.request('POST', '/api/v1/dex/market/price', payload);
    if (data && data[tokenAddress]) {
      return parseFloat(data[tokenAddress]);
    }
    throw new Error(`[BinanceWeb3Client] No se encontró cotización para el token ${tokenAddress} en la red ${chainId}`);
  }

  /**
   * Obtiene cotizaciones en masa (batch) de tokens DeFi para optimizar llamadas.
   */
  public async getBatchTokenPrices(tokenAddresses: string[], chainId: string): Promise<Record<string, number>> {
    if (tokenAddresses.length === 0) return {};
    
    const payload = {
      tokens: tokenAddresses,
      chainId
    };
    const data = await this.request('POST', '/api/v1/dex/market/price', payload);
    const result: Record<string, number> = {};
    for (const addr of tokenAddresses) {
      if (data && data[addr]) {
        result[addr] = parseFloat(data[addr]);
      }
    }
    return result;
  }

  /**
   * Obtiene la transacción para autorizar (Approve) que el contrato de swap mueva un token EVM.
   */
  public async buildApproveTx(
    tokenAddress: string,
    amount: string,
    walletAddress: string,
    chainId: string
  ): Promise<any> {
    const query = `?tokenAddress=${tokenAddress}&amount=${amount}&walletAddress=${walletAddress}&chainId=${chainId}`;
    return this.request('GET', `/api/v1/dex/aggregator/approve-transaction${query}`);
  }

  /**
   * Firma y transmite una transacción EVM (BNB Chain / Base) de forma local.
   */
  public async executeEvmTransaction(txData: any, customRpcUrl?: string): Promise<string> {
    if (!config.evmPrivateKey) {
      throw new Error('[BinanceWeb3Client] EVM_PRIVATE_KEY no configurado en .env.');
    }

    const chainIdStr = txData.chainId.toString();
    const rpcUrl = customRpcUrl || DEFAULT_RPC_URLS[chainIdStr] || 'https://bsc-dataseed.binance.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(config.evmPrivateKey, provider);

    log.info(`Firmando y transmitiendo transacción EVM localmente... Red: ${chainIdStr} | Hacia: ${txData.to}`);

    // Estructurar tx y obtener el nonce actualizado
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    
    let valBig = BigInt(0);
    if (txData.value !== undefined) {
      valBig = typeof txData.value === 'bigint' ? txData.value : BigInt(txData.value.toString());
    }

    // Convertir valores a BigInt requeridos por ethers v6
    const tx: ethers.TransactionRequest = {
      to: txData.to,
      data: txData.data,
      value: valBig,
      nonce: nonce,
      chainId: parseInt(chainIdStr, 10),
    };

    // Estimar gas si no viene provisto o es inconsistente
    try {
      tx.gasLimit = await provider.estimateGas(tx);
    } catch {
      tx.gasLimit = txData.estimatedGas ? BigInt(txData.estimatedGas.toString()) : BigInt(300000);
    }

    // Obtener fee estimado de red
    const feeData = await provider.getFeeData();
    tx.gasPrice = feeData.gasPrice ?? BigInt(20000000000); // 20 Gwei fallback

    const response = await wallet.sendTransaction(tx);
    log.info(`Transmisión EVM exitosa. Hash de transacción: ${response.hash}`);
    return response.hash;
  }

  /**
   * Firma y transmite una transacción de Solana de forma local.
   */
  public async executeSolanaTransaction(swapTxDataBase64: string, customRpcUrl?: string): Promise<string> {
    if (!config.solanaPrivateKey) {
      throw new Error('[BinanceWeb3Client] SOLANA_PRIVATE_KEY no configurado en .env.');
    }

    const rpcUrl = customRpcUrl || DEFAULT_RPC_URLS['solana'];
    const connection = new Connection(rpcUrl, 'confirmed');

    // Cargar clave secreta Solana (formato Base58)
    const secretKeyBytes = bs58.decode(config.solanaPrivateKey);
    const keypair = Keypair.fromSecretKey(secretKeyBytes);

    log.info(`Decodificando transacción serializada de Solana... Dirección: ${keypair.publicKey.toBase58()}`);

    // Binance Web3 API devuelve transacciones serializadas en formato Base64 (VersionedTransaction para compatibilidad con Address Lookup Tables)
    const txBuffer = Buffer.from(swapTxDataBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // Firmar la transacción localmente
    transaction.sign([keypair]);

    log.info('Transmitiendo transacción firmada a la red de Solana...');
    
    // Enviar y confirmar
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    log.info(`Transmisión Solana exitosa. Hash (Firma): ${signature}`);
    return signature;
  }
}
