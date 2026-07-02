import crypto from 'crypto';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { BinanceWeb3Client, Web3QuoteResponse } from '../../cexAdapters/binanceWeb3Client.js';
import { db } from '../../db.js';
import { createLogger } from '../../logger.js';
import { config as globalConfig } from '../../config.js';

const log = createLogger('BinanceWeb3Agartha');

export interface Web3PositionState {
  symbol: string;
  tokenAddress: string;
  positionQty: number;
  entryPrice: number;
  peakPrice: number;
  isTrailingActive: boolean;
  minPriceSinceTracking: number;
  buyState: 'WAITING_FOR_TRIGGER' | 'IN_POSITION' | 'LIQUIDATING';
  entryTimestamp?: number;
}

export interface BinanceWeb3AgarthaConfig {
  chainId: string;                        // '56' (BSC), '8453' (Base), 'solana'
  walletAddress: string;                  // Billetera del usuario
  quoteAssetSymbol: string;              // 'USDT' o 'USDC'
  quoteAssetAddress: string;             // Dirección del USDT/USDC en la red
  notionalAmount: number;                 // Cantidad de quoteAsset a gastar por swap (ej: 10)
  trailingEntryPct: number;
  trailingExitPct: number;
  activationProfitPct: number;
  maxHoldingMinutes: number;
  maxConcurrentPositions: number;
  symbols: string[];                      // Lista de nombres de tokens (ej: ['RE', 'ALLO'])
  tokenAddresses: Record<string, string>; // Mapa de símbolo a su dirección de contrato o Mint Solana
}

const RPC_URLS: Record<string, string> = {
  '56': 'https://bsc-dataseed.binance.org',
  '8453': 'https://mainnet.base.org',
  'solana': 'https://api.mainnet-beta.solana.com'
};

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

export class BinanceWeb3AgarthaStrategy {
  private client: BinanceWeb3Client;
  private config: BinanceWeb3AgarthaConfig;
  private states: Record<string, Web3PositionState> = {};
  private blacklist: string[] = ['SCAM', 'RUG', 'HONEYPOT'];
  private lastEquityLogTimestamp = 0;
  private evmProvider: ethers.JsonRpcProvider | null = null;
  private solanaConnection: Connection | null = null;

  constructor(client: BinanceWeb3Client, config: BinanceWeb3AgarthaConfig) {
    this.client = client;
    this.config = config;

    // Inicializar proveedores RPC locales
    const rpcUrl = RPC_URLS[this.config.chainId];
    if (this.config.chainId === 'solana') {
      this.solanaConnection = new Connection(rpcUrl, 'confirmed');
    } else {
      this.evmProvider = new ethers.JsonRpcProvider(rpcUrl);
    }
  }

  async init(): Promise<void> {
    this.loadState();

    log.info(`[Web3 Agartha] Inicializando estrategia DeFi en la red ChainID: ${this.config.chainId}.`);
    log.info(`Billetera configurada: ${this.config.walletAddress}`);
    log.info(`Universo de tokens candidatos: [${this.config.symbols.join(', ')}]`);
    log.info(`Límite de posiciones DeFi concurrentes: ${this.config.maxConcurrentPositions}`);
  }

  /**
   * Ejecuta un ciclo del tick de la estrategia en DeFi.
   */
  async tick(): Promise<void> {
    const addresses = Object.values(this.config.tokenAddresses);
    if (addresses.length === 0) return;

    try {
      // 1. Obtener precios en masa (batch) desde Binance Web3 API (peso mínimo)
      const prices = await this.client.getBatchTokenPrices(addresses, this.config.chainId);

      // 1.2 Imprimir balance y Equity Total de la billetera DeFi una vez por minuto
      await this.logEquitySummary(prices);

      // 2. Contar posiciones activas
      let activeCount = 0;
      for (const sym of this.config.symbols) {
        const state = this.states[sym.toUpperCase()];
        if (state && (state.positionQty > 0 || state.buyState === 'IN_POSITION' || state.buyState === 'LIQUIDATING')) {
          activeCount++;
        }
      }

      // 3. Procesar cada token
      for (const symbol of this.config.symbols) {
        const symUpper = symbol.toUpperCase();
        const tokenAddr = this.config.tokenAddresses[symUpper];
        if (!tokenAddr) continue;

        try {
          if (this.isBlacklisted(symUpper)) continue;

          const currentPrice = prices[tokenAddr];
          if (!currentPrice || currentPrice <= 0) {
            continue;
          }

          // Inicializar estado de seguimiento si es nuevo
          if (!this.states[symUpper]) {
            this.states[symUpper] = {
              symbol: symUpper,
              tokenAddress: tokenAddr,
              positionQty: 0,
              entryPrice: 0,
              peakPrice: 0,
              isTrailingActive: false,
              minPriceSinceTracking: currentPrice,
              buyState: 'WAITING_FOR_TRIGGER'
            };
          }

          const state = this.states[symUpper];

          if (state.buyState === 'WAITING_FOR_TRIGGER') {
            if (activeCount >= this.config.maxConcurrentPositions) {
              continue;
            }

            // Actualizar mínimo histórico
            if (currentPrice < state.minPriceSinceTracking) {
              state.minPriceSinceTracking = currentPrice;
              this.saveState();
            }

            const reboundPct = ((currentPrice - state.minPriceSinceTracking) / state.minPriceSinceTracking) * 100;
            log.info(`[DeFi ${symUpper}] Rastreo Entrada: Precio=$${currentPrice.toFixed(6)} | Mínimo=$${state.minPriceSinceTracking.toFixed(6)} | Rebote=${reboundPct.toFixed(2)}% (Target >= ${this.config.trailingEntryPct}%)`);

            if (reboundPct >= this.config.trailingEntryPct) {
              log.warn(`📈 [DeFi ${symUpper}] ¡Gatillo de COMPRA detectado en Swap! Rebote: ${reboundPct.toFixed(2)}%`);
              await this.executeEntryBuy(symUpper, tokenAddr, currentPrice);
              activeCount++;
            }

          } else if (state.buyState === 'IN_POSITION') {
            // Evaluar límite de tiempo (Time Stop)
            const elapsed = state.entryTimestamp ? (Date.now() - state.entryTimestamp) / 60000 : 0;
            if (this.config.maxHoldingMinutes > 0 && elapsed >= this.config.maxHoldingMinutes) {
              log.warn(`🚨 [DeFi ${symUpper}] Time Stop alcanzado (${elapsed.toFixed(1)} mins). Iniciando liquidación...`);
              await this.executeExitSell(symUpper, tokenAddr, currentPrice, 'TIME_STOP');
              continue;
            }

            // Actualizar pico histórico
            if (currentPrice > state.peakPrice) {
              state.peakPrice = currentPrice;
              this.saveState();
            }

            // Evaluar activación de trailing stop
            const targetActivation = state.entryPrice * (1 + this.config.activationProfitPct / 100);
            if (!state.isTrailingActive && state.peakPrice >= targetActivation) {
              state.isTrailingActive = true;
              log.warn(`🔔 [DeFi ${symUpper}] Trailing Stop ACTIVADO. PeakPrice($${state.peakPrice.toFixed(6)}) >= Target($${targetActivation.toFixed(6)})`);
              this.saveState();
            }

            if (state.isTrailingActive) {
              const floor = state.peakPrice * (1 - this.config.trailingExitPct / 100);
              const drop = ((state.peakPrice - currentPrice) / state.peakPrice) * 100;
              const pnl = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;

              log.info(`[DeFi ${symUpper}] Trailing: Entrada=$${state.entryPrice.toFixed(6)} | Pico=$${state.peakPrice.toFixed(6)} | Piso=$${floor.toFixed(6)} | Caída=${drop.toFixed(2)}% | PnL=${pnl.toFixed(2)}%`);

              if (currentPrice <= floor) {
                log.warn(`📉 [DeFi ${symUpper}] Trailing Stop gatillado. Liquidando posición swap...`);
                await this.executeExitSell(symUpper, tokenAddr, currentPrice, 'TRAILING_STOP');
              }
            } else {
              log.info(`[DeFi ${symUpper}] En posición: Entrada=$${state.entryPrice.toFixed(6)} | Pico=$${state.peakPrice.toFixed(6)} | Esperando activación...`);
            }
          }
        } catch (symErr: any) {
          log.error(`Error procesando token ${symUpper}: ${symErr.message}`);
        }
      }
    } catch (err: any) {
      log.error(`Fallo en tick DeFi Agartha: ${err.message}`);
    }
  }

  /**
   * Escanea la seguridad del token en DeFi (Honeypot, Taxes, Scam) antes de comprar.
   */
  private async performSecurityAudit(tokenAddress: string): Promise<boolean> {
    const binanceChainId = this.config.chainId === 'solana' ? 'CT_501' : this.config.chainId;
    const url = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit';
    const requestId = crypto.randomUUID ? crypto.randomUUID() : 'd6727c70-de6c-4fad-b1d7-c05422d5f26b';
    
    const payload = {
      binanceChainId,
      contractAddress: tokenAddress,
      requestId
    };

    try {
      log.info(`[Audit] Iniciando escaneo de seguridad on-chain para ${tokenAddress}...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'binance-web3/1.4 (Skill)'
        },
        body: JSON.stringify(payload)
      });

      const resJson = await response.json() as any;
      if (resJson && resJson.success && resJson.data) {
        const audit = resJson.data;
        if (audit.hasResult && audit.isSupported) {
          const riskLevel = audit.riskLevel ?? 0;
          const riskEnum = audit.riskLevelEnum || 'UNKNOWN';
          const buyTax = audit.extraInfo?.buyTax || '0';
          const sellTax = audit.extraInfo?.sellTax || '0';
          
          log.info(`[Audit] Resultado: Nivel de Riesgo = ${riskEnum} (${riskLevel}) | Impuestos: Compra=${buyTax}%, Venta=${sellTax}%`);
          
          if (riskLevel >= 4) {
            log.error(`🚨 [Audit] Escaneo ABORTÓ la operación: Nivel de riesgo CRÍTICO (${riskEnum}) detectado.`);
            return false;
          }
          
          const buyTaxNum = parseFloat(buyTax);
          const sellTaxNum = parseFloat(sellTax);
          if (buyTaxNum > 10 || sellTaxNum > 10) {
            log.error(`🚨 [Audit] Escaneo ABORTÓ la operación: Impuestos abusivos (Compra: ${buyTax}%, Venta: ${sellTax}%).`);
            return false;
          }
        }
      }
    } catch (auditErr: any) {
      log.error(`[Audit] No se pudo completar el escaneo (error de red o API): ${auditErr.message}`);
    }
    return true;
  }

  /**
   * Ejecuta el swap de entrada (Quote Asset -> Alpha Token).
   */
  private async executeEntryBuy(symbol: string, tokenAddress: string, currentPrice: number) {
    const state = this.states[symbol];
    state.buyState = 'LIQUIDATING';

    try {
      // 1. Auditoría de Seguridad Pre-Trade (Anti-Scam / Honeypot Check)
      const isSafe = await this.performSecurityAudit(tokenAddress);
      if (!isSafe) {
        state.buyState = 'WAITING_FOR_TRIGGER';
        state.minPriceSinceTracking = currentPrice;
        this.saveState();
        return;
      }

      const quoteBalance = await this.getOnChainBalance(this.config.quoteAssetAddress);
      if (quoteBalance < this.config.notionalAmount) {
        log.error(`[DeFi ${symbol}] Compra abortada: Caja insuficiente en la red DeFi (${quoteBalance.toFixed(2)} ${this.config.quoteAssetSymbol} disponible).`);
        state.buyState = 'WAITING_FOR_TRIGGER';
        state.minPriceSinceTracking = currentPrice;
        this.saveState();
        return;
      }

      log.warn(`[DeFi ${symbol}] Generando swap de compra en agregador...`);
      const amountRaw = this.config.notionalAmount.toString();
      
      const swapData = await this.client.buildSwapTx(
        this.config.quoteAssetAddress,
        tokenAddress,
        amountRaw,
        this.config.walletAddress,
        this.config.chainId
      );

      // Si es EVM, verificar aprobación del token de pago antes de operar
      if (this.config.chainId !== 'solana') {
        await this.ensureAllowance(this.config.quoteAssetAddress, swapData.to, amountRaw);
      }

      log.warn(`[DeFi ${symbol}] Firmando y transmitiendo swap de compra...`);
      let hash = '';
      if (this.config.chainId === 'solana') {
        hash = await this.client.executeSolanaTransaction(swapData.transaction);
      } else {
        hash = await this.client.executeEvmTransaction(swapData);
      }

      // Estimar cantidad comprada (la API suele devolver el output estimado)
      const expectedOutput = swapData.toAmount ? parseFloat(swapData.toAmount) : (this.config.notionalAmount / currentPrice);

      state.positionQty = expectedOutput;
      state.entryPrice = currentPrice;
      state.peakPrice = currentPrice;
      state.isTrailingActive = false;
      state.buyState = 'IN_POSITION';
      state.entryTimestamp = Date.now();

      log.warn(`✅ [DeFi ${symbol}] SWAP COMPRA EJECUTADO. Hash: ${hash} | Cantidad Estimada: ${expectedOutput.toFixed(4)}`);
      
      db.logTransaction('AGARTHA_DEFI_BUY', hash, 'SUCCESS', {
        symbol,
        tokenAddress,
        cost: this.config.notionalAmount,
        qty: expectedOutput,
        price: currentPrice
      });

    } catch (err: any) {
      log.error(`❌ Falló la compra swap de ${symbol}: ${err.message}`);
      state.buyState = 'WAITING_FOR_TRIGGER';
      state.minPriceSinceTracking = currentPrice;
    }

    this.saveState();
  }

  /**
   * Ejecuta el swap de salida (Alpha Token -> Quote Asset).
   */
  private async executeExitSell(symbol: string, tokenAddress: string, currentPrice: number, reason: string) {
    const state = this.states[symbol];
    state.buyState = 'LIQUIDATING';

    try {
      // 1. Consultar balance real libre del token en la blockchain para evitar comisiones o redondeos
      const realBalance = await this.getOnChainBalance(tokenAddress);
      if (realBalance <= 0) {
        log.error(`[DeFi ${symbol}] Liquidación cancelada: Balance en billetera es 0.`);
        this.resetSymbolState(symbol, currentPrice);
        return;
      }

      log.warn(`[DeFi ${symbol}] Solicitando swap de salida para liquidar ${realBalance.toFixed(6)} ${symbol}...`);

      const swapData = await this.client.buildSwapTx(
        tokenAddress,
        this.config.quoteAssetAddress,
        realBalance.toString(),
        this.config.walletAddress,
        this.config.chainId
      );

      // Si es EVM, verificar aprobación del token a vender
      if (this.config.chainId !== 'solana') {
        await this.ensureAllowance(tokenAddress, swapData.to, realBalance.toString());
      }

      log.warn(`[DeFi ${symbol}] Transmitiendo swap de venta por ${reason}...`);
      let hash = '';
      if (this.config.chainId === 'solana') {
        hash = await this.client.executeSolanaTransaction(swapData.transaction);
      } else {
        hash = await this.client.executeEvmTransaction(swapData);
      }

      const receivedQuote = swapData.toAmount ? parseFloat(swapData.toAmount) : (realBalance * currentPrice);
      const grossPnl = receivedQuote - (realBalance * state.entryPrice);
      const pnlPct = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;

      log.warn(`✅ [DeFi ${symbol}] SWAP VENTA EJECUTADO (${reason}): PnL=${grossPnl.toFixed(4)} USD (${pnlPct.toFixed(2)}%) | Hash: ${hash}`);

      db.logTransaction('AGARTHA_DEFI_LIQUIDATED', hash, 'SUCCESS', {
        symbol,
        tokenAddress,
        reason,
        entryPrice: state.entryPrice,
        exitPrice: currentPrice,
        qty: realBalance,
        profitUsd: grossPnl,
        pnlPct: pnlPct
      });

      this.resetSymbolState(symbol, currentPrice);

    } catch (err: any) {
      log.error(`❌ Falló la liquidación swap de ${symbol}: ${err.message}`);
      state.buyState = 'IN_POSITION'; // Volver a reintentar
    }

    this.saveState();
  }

  /**
   * Asegura que el router tenga permiso de mover los tokens (Solo EVM).
   */
  private async ensureAllowance(tokenAddress: string, spender: string, amount: string): Promise<void> {
    if (this.config.chainId === 'solana' || !this.evmProvider || !globalConfig.evmPrivateKey) return;

    const wallet = new ethers.Wallet(globalConfig.evmPrivateKey, this.evmProvider);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    const decimals = await contract.decimals();
    const amountBig = ethers.parseUnits(amount, decimals);
    
    const allowance = await contract.allowance(wallet.address, spender);
    if (allowance < amountBig) {
      log.warn(`[EVM Approve] Allowance insuficiente. Autorizando spender ${spender} para mover token ${tokenAddress}...`);
      
      const approveTx = await this.client.buildApproveTx(tokenAddress, amount, wallet.address, this.config.chainId);
      const tx = {
        to: approveTx.to,
        data: approveTx.data,
        value: BigInt(approveTx.value || '0'),
        chainId: parseInt(this.config.chainId, 10)
      };

      const hash = await this.client.executeEvmTransaction(tx);
      log.info(`[EVM Approve] Transmisión de aprobación exitosa. Esperando confirmación de hash: ${hash}...`);
      
      // Esperar brevemente a que el bloque confirme
      await this.evmProvider.waitForTransaction(hash, 1);
      log.info('[EVM Approve] Token aprobado con éxito en la red.');
    }
  }

  /**
   * Consulta el saldo on-chain de forma nativa desde la red de nodos RPC.
   */
  private async getOnChainBalance(tokenAddress: string): Promise<number> {
    try {
      if (this.config.chainId === 'solana' && this.solanaConnection) {
        const pubkey = new PublicKey(this.config.walletAddress);
        
        // Si el token a buscar es el nativo (ej: SOL) o si es el quote token
        if (tokenAddress.toLowerCase() === 'sol' || tokenAddress.toLowerCase() === 'native') {
          const lamports = await this.solanaConnection.getBalance(pubkey);
          return lamports / 1e9;
        }
        
        // Es un token SPL
        const mintPubkey = new PublicKey(tokenAddress);
        const accounts = await this.solanaConnection.getParsedTokenAccountsByOwner(pubkey, { mint: mintPubkey });
        if (accounts.value.length === 0) return 0;
        return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;

      } else if (this.evmProvider) {
        // Nativo EVM (BNB / ETH)
        if (tokenAddress.toLowerCase() === 'native' || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
          const bal = await this.evmProvider.getBalance(this.config.walletAddress);
          return parseFloat(ethers.formatEther(bal));
        }

        // Token ERC20
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.evmProvider);
        const bal = await contract.balanceOf(this.config.walletAddress);
        const decimals = await contract.decimals();
        return parseFloat(ethers.formatUnits(bal, decimals));
      }
    } catch (err: any) {
      log.error(`Fallo consultando balance on-chain del token ${tokenAddress}: ${err.message}`);
    }
    return 0;
  }

  /**
   * Reporta el estado de balances y Equity DeFi en caliente cada 60s.
   */
  private async logEquitySummary(prices: Record<string, number>): Promise<void> {
    const now = Date.now();
    if (now - this.lastEquityLogTimestamp < 60000) return;
    this.lastEquityLogTimestamp = now;

    try {
      const freeQuote = await this.getOnChainBalance(this.config.quoteAssetAddress);
      let activePosValue = 0;
      const details: string[] = [];

      for (const symbol of this.config.symbols) {
        const symUpper = symbol.toUpperCase();
        const state = this.states[symUpper];
        if (state && state.positionQty > 0) {
          const tokenAddr = this.config.tokenAddresses[symUpper];
          const price = prices[tokenAddr] || state.entryPrice;
          const val = state.positionQty * price;
          activePosValue += val;

          const pnl = ((price - state.entryPrice) / state.entryPrice) * 100;
          details.push(`${symUpper}: ${state.positionQty.toFixed(4)} (~$${val.toFixed(2)} USD, PnL: ${pnl.toFixed(2)}%)`);
        }
      }

      const totalEquity = freeQuote + activePosValue;

      log.warn(`=====================================================================`);
      log.warn(`💰 BILLETERA DEFI GENERAL (HELENA × AGARTHA DEFI)`);
      log.warn(`   • Red / ChainID:                  ${this.config.chainId}`);
      log.warn(`   • Dirección:                      ${this.config.walletAddress}`);
      log.warn(`   • Equity Total (Valor de Cuenta): $${totalEquity.toFixed(2)} USD`);
      log.warn(`   • Saldo ${this.config.quoteAssetSymbol} Disponible:     $${freeQuote.toFixed(2)} USD`);
      log.warn(`   • Valor en Activos (Posiciones):  $${activePosValue.toFixed(2)} USD`);
      if (details.length > 0) {
        log.info(`   • Detalle de Posiciones Activas:`);
        for (const d of details) {
          log.info(`     - ${d}`);
        }
      } else {
        log.info(`   • Sin posiciones activas.`);
      }
      log.warn(`=====================================================================`);

    } catch (err: any) {
      log.error('Error al generar el reporte de Equity DeFi:', err.message);
    }
  }

  private resetSymbolState(symbol: string, currentPrice: number) {
    const tokenAddr = this.config.tokenAddresses[symbol];
    this.states[symbol] = {
      symbol: symbol,
      tokenAddress: tokenAddr,
      positionQty: 0,
      entryPrice: 0,
      peakPrice: 0,
      isTrailingActive: false,
      minPriceSinceTracking: currentPrice,
      buyState: 'WAITING_FOR_TRIGGER'
    };
  }

  private isBlacklisted(symbol: string): boolean {
    const sym = symbol.toUpperCase();
    return this.blacklist.some(item => sym.includes(item));
  }

  private saveState() {
    db.saveCustomData('agartha_web3_states', this.states);
  }

  private loadState() {
    const saved = db.getCustomData('agartha_web3_states');
    if (saved && typeof saved === 'object') {
      this.states = saved;
      log.info(`Estados restaurados para la billetera DeFi de Agartha: [${Object.keys(this.states).join(', ')}]`);
    }
  }
}
