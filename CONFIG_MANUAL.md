# Manual de Configuración (.env)

Este manual detalla todas las variables de entorno soportadas por el bot en el archivo `.env`.

## Configuración General

| Variable | Descripción | Valor Ejemplo |
|---|---|---|
| `XRPL_WS_URL` | Endpoint WebSocket del nodo XRPL | `wss://s.altnet.rippletest.net:51233` |
| `XRPL_WALLET_SEED` | Semilla de la billetera del bot (si se deja vacía, se genera una de prueba al inicio) | `sEdV...` |
| `STRATEGY` | Nombre de la estrategia a activar (`market_maker`, `dorothy`, `elphaba`, etc.) | `market_maker` |
| `USD_ISSUER` | Dirección del emisor de USD en el DEX del XRPL (Bitstamp por defecto) | `rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B` |
| `LOG_LEVEL` | Nivel de logs mostrados en consola (`DEBUG`, `INFO`, `WARN`, `ERROR`) | `INFO` |

## Notificaciones de Telegram

Para activar alertas en tiempo real, crea un bot con BotFather y obtén tu Chat ID:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCDefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=987654321
HEALTH_INTERVAL_SECONDS=300
```

## Credenciales de CEX (Opcionales para Arbitraje)

```env
BINANCE_API_KEY=tu_api_key_de_binance
BINANCE_API_SECRET=tu_api_secret_de_binance
```

## Exclusión/Desactivación de APIs de Oráculo

Si no dispones de API keys para fuentes externas de precios, puedes desactivarlas para evitar peticiones destinadas a fallar:

```env
DISABLE_CRYPTOCOMPARE=true
DISABLE_BINANCE=false
```
