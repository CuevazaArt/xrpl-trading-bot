import { Client, Wallet, Payment } from 'xrpl';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { db } from './db.js';

const log = createLogger('ArbitrageScanner');

/**
 * Inicia el escáner de arbitraje atómico en el mismo proceso y cliente
 * compartido con el bot principal, evitando colisiones de secuencia.
 */
export function startArbitrageScanner(client: Client, wallet: Wallet) {
  log.info(`Escáner de arbitraje atómico activado para: ${wallet.address}`);

  client.connection.on('ledgerClosed', async (ledger) => {
    log.debug(`[Arbitraje] Escaneando ledger #${ledger.ledger_index}...`);
    try {
      await scanForUSDArbitrage(client, wallet);
      await scanForXRPArbitrage(client, wallet);
    } catch (error) {
      log.error('Error durante el escaneo de arbitraje:', error);
    }
  });
}

/**
 * Escanea ciclos de USD: Enviar menos de X USD para recibir exactamente X USD.
 */
async function scanForUSDArbitrage(client: Client, wallet: Wallet) {
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
          
          await executeAtomicArbitrage(client, wallet, {
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
async function scanForXRPArbitrage(client: Client, wallet: Wallet) {
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

          await executeAtomicArbitrage(client, wallet, targetAmountXRP, alt.source_amount, alt.paths_computed);
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

    const prepared = await client.autofill(txJSON);

    const maxFeeDrops = 20000;
    if (prepared.Fee && parseInt(prepared.Fee, 10) > maxFeeDrops) {
      log.warn(`Arbitraje cancelado: Comisión de red (${prepared.Fee} drops) excede el máximo de arbitraje (${maxFeeDrops} drops)`);
      return;
    }

    const signed = wallet.sign(prepared);
    const response = await client.submit(signed.tx_blob);
    const result = response.result.engine_result;

    if (result === 'tesSUCCESS' || result === 'terQUEUED') {
      log.info(`¡Arbitraje enviado con éxito! Resultado: ${result} | Hash: ${response.result.tx_json.hash}`);
      db.logTransaction('ARBITRAGE_EXEC', response.result.tx_json.hash || '', result, {
        destinationAmount,
        sendMaxAmount
      });
    } else {
      log.error(`Fallo inmediato al enviar arbitraje: ${result}`);
    }
  } catch (error) {
    log.error('Excepción al ejecutar transacción de arbitraje:', error);
  }
}
