/**
 * Script de mantenimiento: Cancela TODAS las ofertas abiertas de la cuenta
 * para liberar la reserva de XRP bloqueada por OwnerCount elevado.
 *
 * Versión HFT: envía cancelaciones en lotes asíncronos (~20x más rápido).
 *
 * Uso: npm run cleanup
 */
import { Client, Wallet, OfferCancel } from 'xrpl';
import { config } from './config.js';
import { createLogger } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

const log = createLogger('Cleanup');

const BATCH_SIZE = 10; // Cancelaciones simultáneas por lote
const BATCH_DELAY_MS = 4000; // Esperar ~1 ledger entre lotes

async function getAllOffers(client: Client, account: string): Promise<any[]> {
  const allOffers: any[] = [];
  let marker: any = undefined;

  do {
    const response: any = await client.request({
      command: 'account_offers',
      account,
      ledger_index: 'validated',
      limit: 400,
      ...(marker ? { marker } : {})
    });
    allOffers.push(...(response.result.offers || []));
    marker = response.result.marker;
  } while (marker);

  return allOffers;
}

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

  // 1. Estado inicial
  const infoBefore = await client.request({
    command: 'account_info',
    account: wallet.address,
    ledger_index: 'validated'
  });
  const ownerCountBefore = infoBefore.result.account_data.OwnerCount || 0;
  const balanceBefore = await client.getXrpBalance(wallet.address);
  log.info(`Estado ANTES: OwnerCount=${ownerCountBefore}, Balance=${balanceBefore} XRP`);

  // 2. Obtener TODAS las ofertas (con paginación)
  const offers = await getAllOffers(client, wallet.address);
  log.info(`Ofertas abiertas encontradas: ${offers.length}`);

  if (offers.length === 0) {
    log.info('No hay ofertas para limpiar. Tu OwnerCount puede deberse a trustlines.');
    await client.disconnect();
    return;
  }

  // 3. Obtener secuencia inicial
  const acctInfo = await client.request({
    command: 'account_info',
    account: wallet.address,
    ledger_index: 'current'
  });
  let localSeq = acctInfo.result.account_data.Sequence;
  log.info(`Secuencia inicial: ${localSeq}. Enviando en lotes de ${BATCH_SIZE}...`);

  // 4. Cancelar en lotes asíncronos
  let cancelled = 0;
  let failed = 0;

  for (let i = 0; i < offers.length; i += BATCH_SIZE) {
    const batch = offers.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (offer) => {
      const seq = localSeq++;
      try {
        const cancelTx: OfferCancel = {
          TransactionType: 'OfferCancel',
          Account: wallet.address,
          OfferSequence: offer.seq,
          Sequence: seq,
          Fee: '12'
        };

        const prepared = await client.autofill(cancelTx, /* multisign */ undefined);
        // Forzar la secuencia local (autofill puede sobreescribirla)
        prepared.Sequence = seq;
        const signed = wallet.sign(prepared);
        const response = await client.submit(signed.tx_blob);

        const engineResult = response.result.engine_result;
        if (engineResult === 'tesSUCCESS' || engineResult === 'terQUEUED') {
          cancelled++;
        } else {
          failed++;
          log.warn(`Oferta seq=${offer.seq}: ${engineResult}`);
        }
      } catch (error) {
        failed++;
        log.error(`Excepción oferta seq=${offer.seq}:`, (error as any).message || error);
      }
    });

    await Promise.all(promises);
    const progress = Math.min(i + BATCH_SIZE, offers.length);
    log.info(`Progreso: ${progress}/${offers.length} enviadas (ok=${cancelled}, fail=${failed})`);

    // Esperar a que el ledger cierre para que se procesen
    if (i + BATCH_SIZE < offers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // 5. Esperar un poco para que el último lote se confirme
  log.info('Esperando confirmación del último lote...');
  await new Promise(r => setTimeout(r, 6000));

  // 6. Estado final
  const infoAfter = await client.request({
    command: 'account_info',
    account: wallet.address,
    ledger_index: 'validated'
  });
  const ownerCountAfter = infoAfter.result.account_data.OwnerCount || 0;
  const balanceAfter = await client.getXrpBalance(wallet.address);

  log.info(`--- LIMPIEZA COMPLETADA ---`);
  log.info(`Canceladas: ${cancelled} | Fallidas: ${failed}`);
  log.info(`Estado DESPUÉS: OwnerCount=${ownerCountAfter}, Balance=${balanceAfter} XRP`);
  log.info(`Reserva liberada: OwnerCount bajó de ${ownerCountBefore} a ${ownerCountAfter} (${ownerCountBefore - ownerCountAfter} objetos eliminados)`);

  await client.disconnect();
}

cleanupOffers().catch(err => {
  log.error('Error fatal en limpieza:', err);
  process.exit(1);
});

