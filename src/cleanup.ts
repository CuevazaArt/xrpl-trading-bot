/**
 * Script de mantenimiento: Cancela TODAS las ofertas abiertas de la cuenta
 * para liberar la reserva de XRP bloqueada por OwnerCount elevado.
 *
 * Uso: npm.cmd run cleanup
 */
import { Client, Wallet, OfferCancel } from 'xrpl';
import { config } from './config.js';
import { createLogger } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

const log = createLogger('Cleanup');

async function cleanupOffers() {
  if (!config.walletSeed) {
    log.error('ERROR: No se encontró XRPL_WALLET_SEED en .env');
    process.exit(1);
  }

  const client = new Client(config.xrplWsUrl);
  await client.connect();
  log.info(`Conectado a: ${config.xrplWsUrl}`);

  const wallet = Wallet.fromSeed(config.walletSeed);
  log.info(`Cuenta: ${wallet.address}`);

  // 1. Obtener info de la cuenta antes de limpiar
  const infoBefore = await client.request({
    command: 'account_info',
    account: wallet.address,
    ledger_index: 'validated'
  });
  const ownerCountBefore = infoBefore.result.account_data.OwnerCount || 0;
  const balanceBefore = await client.getXrpBalance(wallet.address);
  log.info(`Estado ANTES: OwnerCount=${ownerCountBefore}, Balance=${balanceBefore} XRP`);

  // 2. Obtener todas las ofertas abiertas
  const offersResponse = await client.request({
    command: 'account_offers',
    account: wallet.address,
    ledger_index: 'validated',
    limit: 400
  });

  const offers = offersResponse.result.offers || [];
  log.info(`Ofertas abiertas encontradas: ${offers.length}`);

  if (offers.length === 0) {
    log.info('No hay ofertas para limpiar. Tu OwnerCount puede deberse a trustlines.');
    await client.disconnect();
    return;
  }

  // 3. Cancelar cada oferta
  let cancelled = 0;
  let failed = 0;

  for (const offer of offers) {
    try {
      const cancelTx: OfferCancel = {
        TransactionType: 'OfferCancel',
        Account: wallet.address,
        OfferSequence: offer.seq
      };

      const prepared = await client.autofill(cancelTx);
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);

      const meta = result.result.meta;
      const engineResult = typeof meta === 'object' && meta !== null ? (meta as any).TransactionResult : 'unknown';

      if (engineResult === 'tesSUCCESS') {
        cancelled++;
        if (cancelled % 10 === 0 || cancelled === offers.length) {
          log.info(`Progreso: ${cancelled}/${offers.length} ofertas canceladas...`);
        }
      } else {
        failed++;
        log.warn(`Fallo al cancelar oferta seq=${offer.seq}: ${engineResult}`);
      }
    } catch (error) {
      failed++;
      log.error(`Excepción al cancelar oferta seq=${offer.seq}:`, error);
    }
  }

  // 4. Resultados
  log.info(`--- LIMPIEZA COMPLETADA ---`);
  log.info(`Canceladas: ${cancelled} | Fallidas: ${failed}`);

  // 5. Estado final
  const infoAfter = await client.request({
    command: 'account_info',
    account: wallet.address,
    ledger_index: 'validated'
  });
  const ownerCountAfter = infoAfter.result.account_data.OwnerCount || 0;
  const balanceAfter = await client.getXrpBalance(wallet.address);
  log.info(`Estado DESPUÉS: OwnerCount=${ownerCountAfter}, Balance=${balanceAfter} XRP`);
  log.info(`Reserva liberada: OwnerCount bajó de ${ownerCountBefore} a ${ownerCountAfter} (${ownerCountBefore - ownerCountAfter} objetos eliminados)`);

  await client.disconnect();
}

cleanupOffers().catch(err => {
  log.error('Error fatal en limpieza:', err);
  process.exit(1);
});
