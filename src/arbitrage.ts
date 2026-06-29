import { Client, Wallet, Payment } from 'xrpl';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { db } from './db.js';
import { XRPLOrderManager } from './orderManager.js';

const log = createLogger('ArbitrageScanner');

/**
 * Inicia el escáner de arbitraje atómico en el mismo proceso y cliente
 * compartido con el bot principal, evitando colisiones de secuencia.
 */
export function startArbitrageScanner(client: Client, wallet: Wallet, orderManager: XRPLOrderManager) {
  log.info(`Escáner de arbitraje atómico activado para: ${wallet.address}`);

  client.connection.on('ledgerClosed', async (ledger) => {
    log.debug(`[Arbitraje] Escaneando ledger #${ledger.ledger_index}...`);
    try {
      await scanForUSDArbitrage(client, wallet, orderManager);
      await scanForXRPArbitrage(client, wallet, orderManager);
    } catch (error) {
      log.error('Error durante el escaneo de arbitraje:', error);
    }
  });
}

/**
 * Escanea ciclos de USD: Enviar menos de X USD para recibir exactamente X USD.
 */
async function scanForUSDArbitrage(client: Client, wallet: Wallet, orderManager: XRPLOrderManager) {
  const targetAmountUSD = '50.00';
  const usdIssuer = config.usdIssuer;

  try {
    const response = await client.request({
      command: 'ripple_path_find',
      source_account: wallet.address,
      destination_account: wallet.address,
      destination_amount: {
        currency: 'USD',
        value: targetAmountUSD,
        issuer: usdIssuer
      },
      source_currencies: [
        { currency: 'USD', issuer: usdIssuer }
      ]
    });

    const alternatives = response.result.alternatives;
    if (!alternatives || alternatives.length === 0) {
      return;
    }

    for (const alt of alternatives) {
      if (typeof alt.source_amount === 'object' && alt.source_amount.currency === 'USD') {
        const costUSD = parseFloat(alt.source_amount.value);
        const targetUSD = parseFloat(targetAmountUSD);
        const profit = targetUSD - costUSD;

        const minProfit = 0.05;

        if (profit > minProfit) {
          log.info(`¡Oportunidad de Arbitraje USD! Costo: ${costUSD.toFixed(4)} USD | Retorno: ${targetUSD.toFixed(4)} USD | Beneficio: +${profit.toFixed(4)} USD`);
          
          await executeAtomicArbitrage(client, wallet, orderManager, {
            currency: 'USD',
            value: targetAmountUSD,
            issuer: usdIssuer
          }, alt.source_amount, alt.paths_computed);
        }
      }
    }
  } catch (error) {
    log.error('Error en escáner de arbitraje USD:', error);
  }
}

/**
 * Escanea ciclos de XRP: Enviar menos de X XRP para recibir exactamente X XRP.
 */
async function scanForXRPArbitrage(client: Client, wallet: Wallet, orderManager: XRPLOrderManager) {
  const targetAmountXRP = '100000000'; // 100 XRP en drops
  
  try {
    const response = await client.request({
      command: 'ripple_path_find',
      source_account: wallet.address,
      destination_account: wallet.address,
      destination_amount: targetAmountXRP,
      source_currencies: [
        { currency: 'XRP' }
      ]
    });

    const alternatives = response.result.alternatives;
    if (!alternatives || alternatives.length === 0) {
      return;
    }

    for (const alt of alternatives) {
      if (typeof alt.source_amount === 'string') {
        const costDrops = parseInt(alt.source_amount, 10);
        const targetDrops = parseInt(targetAmountXRP, 10);
        const profitDrops = targetDrops - costDrops;

        const minProfitDrops = 100000; // 0.1 XRP

        if (profitDrops > minProfitDrops) {
          const costXRP = costDrops / 1000000;
          const targetXRP = targetDrops / 1000000;
          const profitXRP = profitDrops / 1000000;

          log.info(`¡Oportunidad de Arbitraje XRP! Costo: ${costXRP.toFixed(4)} XRP | Retorno: ${targetXRP.toFixed(4)} XRP | Beneficio: +${profitXRP.toFixed(4)} XRP`);

          await executeAtomicArbitrage(client, wallet, orderManager, targetAmountXRP, alt.source_amount, alt.paths_computed);
        }
      }
    }
  } catch (error) {
    log.error('Error en escáner de arbitraje XRP:', error);
  }
}

/**
 * Ejecuta la transacción de pago con rutas (Payment Path) para bloquear las ganancias atómicamente.
 */
async function executeAtomicArbitrage(
  client: Client,
  wallet: Wallet,
  orderManager: XRPLOrderManager,
  destinationAmount: any,
  sendMaxAmount: any,
  paths: any
) {
  log.info('Ejecutando transacción de arbitraje atómico en el ledger...');
  try {
    const txJSON: Payment = {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: wallet.address,
      Amount: destinationAmount,
      SendMax: sendMaxAmount,
      Paths: paths
    };

    const response = await orderManager.submitGeneric(wallet, txJSON);

    if (response.success && response.result) {
      const result = response.result.result.engine_result;
      log.info(`¡Arbitraje enviado con éxito! Resultado: ${result} | Hash: ${response.hash}`);
      db.logTransaction('ARBITRAGE_EXEC', response.hash || '', result, {
        destinationAmount,
        sendMaxAmount
      });
    } else {
      log.error(`Fallo al enviar arbitraje: ${response.error}`);
    }
  } catch (error) {
    log.error('Excepción al ejecutar transacción de arbitraje:', error);
  }
}
