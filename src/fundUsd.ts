import { Client, Wallet, TrustSet, Payment } from 'xrpl';
import dotenv from 'dotenv';
import path from 'path';
import { saveToEnv } from './utils.js';

// Cargar variables de entorno del archivo .env
dotenv.config();

const xrplWsUrl = process.env.XRPL_WS_URL || 'wss://s.altnet.rippletest.net:51233';
const walletSeed = process.env.XRPL_WALLET_SEED;

async function main() {
  if (!walletSeed) {
    console.error('Error: XRPL_WALLET_SEED no está configurado en tu archivo .env');
    process.exit(1);
  }

  console.log(`Conectando al nodo XRPL en: ${xrplWsUrl}...`);
  const client = new Client(xrplWsUrl);
  await client.connect();

  try {
    // 1. Obtener la billetera del bot
    const botWallet = Wallet.fromSeed(walletSeed);
    console.log(`Billetera del bot cargada: ${botWallet.address}`);

    // 2. Generar y fondear una billetera temporal de Emisor (USD Issuer)
    console.log('Generando y fondeando cuenta emisora temporal de USD en Testnet...');
    const { wallet: issuerWallet } = await client.fundWallet();
    console.log(`Cuenta emisora creada: ${issuerWallet.address}`);

    // 3. Crear la Línea de Confianza (Trustline) del bot al emisor
    console.log(`Estableciendo línea de confianza (Trustline) del bot al emisor para USD...`);
    const trustSetTx: TrustSet = {
      TransactionType: 'TrustSet',
      Account: botWallet.address,
      LimitAmount: {
        currency: 'USD',
        issuer: issuerWallet.address,
        value: '1000000' // Confianza de hasta 1 millón de USD
      }
    };

    const preparedTrust = await client.autofill(trustSetTx);
    const signedTrust = botWallet.sign(preparedTrust);
    const trustResult = await client.submitAndWait(signedTrust.tx_blob);
    const trustTxResult = (trustResult.result.meta as any)?.TransactionResult;

    if (trustTxResult !== 'tesSUCCESS') {
      throw new Error(`Fallo al establecer la Trustline: ${trustTxResult}`);
    }
    console.log('¡Línea de confianza establecida con éxito!');

    // 4. Enviar los USD desde el emisor a la cuenta del bot
    console.log('Emitiendo y enviando 10,000 USD a la cuenta del bot...');
    const paymentTx: Payment = {
      TransactionType: 'Payment',
      Account: issuerWallet.address,
      Destination: botWallet.address,
      Amount: {
        currency: 'USD',
        value: '10000',
        issuer: issuerWallet.address
      }
    };

    const preparedPay = await client.autofill(paymentTx);
    const signedPay = issuerWallet.sign(preparedPay);
    const payResult = await client.submitAndWait(signedPay.tx_blob);
    const payTxResult = (payResult.result.meta as any)?.TransactionResult;

    if (payTxResult !== 'tesSUCCESS') {
      throw new Error(`Fallo al enviar los USD: ${payTxResult}`);
    }

    try {
      saveToEnv('USD_ISSUER', issuerWallet.address);
      console.log('¡Emisor USD guardado automáticamente en tu archivo .env!');
    } catch (err) {
      console.error('Error al guardar el emisor en el archivo .env:', err);
    }

    console.log('------------------------------------------------------------');
    console.log('¡PROCESO COMPLETADO CON ÉXITO!');
    console.log(`Tu cuenta del bot (${botWallet.address}) ahora tiene 10,000 USD de prueba.`);
    console.log(`Dirección del emisor (USD_ISSUER) guardada en .env: ${issuerWallet.address}`);
    console.log('------------------------------------------------------------');
    console.log('Luego compila y reinicia el bot para empezar a operar.');

  } catch (error) {
    console.error('Error durante la ejecución:', error);
  } finally {
    await client.disconnect();
  }
}

main();
