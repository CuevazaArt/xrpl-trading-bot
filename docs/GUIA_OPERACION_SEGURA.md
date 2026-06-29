# 🛡️ Guía de Operación Segura y Buenas Prácticas (Helena Bot)

Esta guía está diseñada para operadores y usuarios de nivel intermedio o principiante. Su objetivo es explicar de forma sencilla cómo desplegar, gestionar y monitorear múltiples instancias de **Helena** minimizando riesgos operativos y financieros.

---

## 💡 Concepto Clave: ¿Cómo escalar tus estrategias en Helena?

En la versión actual de Helena, **cada proceso del bot gestiona una sola billetera operando un par específico**. 

Si deseas operar con:
1. Múltiples billeteras (ej. una para acumular y otra para proveer liquidez).
2. Múltiples estrategias simultáneamente (ej. `market_maker` en XRP/USD y `dorothy` en DCA).
3. Múltiples tokens.

Deberás ejecutar **bucle de procesos separados (Instancias)** corriendo de forma paralela.

---

## ⚠️ Regla de Oro N°1: Evitar Colisiones de Semillas
> [!CAUTION]
> **NUNCA ejecutes dos instancias utilizando la misma semilla de billetera (`XRPL_SEED`) en el mismo par/libro de órdenes.**
>
> Si lo haces, ambas instancias competirán por los mismos números de secuencia de transacción (`Sequence`), cancelándose y pisándose mutuamente. Esto provocará fallos en el ledger y consumirá tus reservas de XRP en comisiones inútiles.

* **Regla básica:** 1 Instancia = 1 Semilla (`.env`) diferente.

---

## 🛠️ Orquestación Fácil con PM2 (Paso a Paso)

Para usuarios no expertos, la forma más segura y estable de correr múltiples instancias en paralelo en Windows o Linux es usando **PM2 (Process Manager 2)**. Evita abrir múltiples ventanas de terminal que pueden cerrarse por accidente.

### Paso 1: Crear tus archivos de configuración
Crea archivos `.env` independientes para cada bot. Por ejemplo:

* **`.env.maker`** (para proveer liquidez):
  ```env
  STRATEGY=market_maker
  XRPL_SEED=sEdV3... (Wallet A)
  DASHBOARD_PORT=3000
  ```
* **`.env.dorothy`** (para acumular en caídas):
  ```env
  STRATEGY=dorothy
  XRPL_SEED=sEdT9... (Wallet B)
  DASHBOARD_PORT=3001  # Debe ser un puerto diferente para no colisionar
  ```

### Paso 2: Configurar `ecosystem.config.cjs`
Modifica o crea el archivo [`ecosystem.config.cjs`](file:///c:/Users/Dell/Desktop/xrpl-trading-bot/ecosystem.config.cjs) en la raíz del proyecto:

```javascript
module.exports = {
  apps: [
    {
      name: "helena-maker",
      script: "./dist/index.js",
      autorestart: true,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: ".env.maker"
      }
    },
    {
      name: "helena-dorothy",
      script: "./dist/index.js",
      autorestart: true,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: ".env.dorothy"
      }
    }
  ]
};
```

### Paso 3: Lanzar y Monitorear
Ejecuta los siguientes comandos en tu consola:
```bash
# Compilar el código TypeScript
npm run build

# Iniciar todas las instancias con PM2
pm2 start ecosystem.config.cjs

# Ver el estado de tus bots corriendo
pm2 status

# Ver logs en tiempo real de todos los bots
pm2 logs
```

---

## 📈 Gestión de Riesgo para Usuarios No Expertos

### 1. Usa la Red de Pruebas (Testnet) y Paper Trading Primero
> [!IMPORTANT]
> Antes de depositar fondos reales en Mainnet, corre tus estrategias por lo menos **48 a 72 horas** en modo simulado para familiarizarte con las oscilaciones y el comportamiento de las órdenes.

* **Paper Trading:** Puedes forzar el modo simulado agregando la bandera `--paper-trading` al arrancar el script, lo cual emulará transacciones sin usar fondos reales en la red de pruebas.

### 2. Configura los Circuit Breakers (Fusibles)
Cada archivo `.env` tiene variables de protección que apagarán el bot si algo sale mal. Asegúrate de configurarlas:
* `MM_MAX_LOSS_USD`: Monto máximo en dólares que estás dispuesto a perder en una sesión antes de que el bot cancele todo y se apague (ej. `5.0` USD).
* `MM_MAX_SESSION_FEE_DROPS`: Límite de comisiones acumuladas. Si la red se congestiona o el bot entra en un ciclo infinito de cancelación/reemplazo, este límite lo detendrá antes de vaciar tu XRP (ej. `5000` drops).
* `MIN_XRP_RESERVE_BUFFER`: Coloca un margen extra de seguridad (ej. `10.0` XRP) para asegurar que el bot nunca intente gastar el balance bloqueado por la reserva base de la red XRPL.

---

## 🛠️ Mantenimiento y Operaciones Comunes

### ¿Cómo ver mis saldos actuales de forma segura?
No necesitas abrir portales externos. Puedes usar el script integrado para ver los balances de tu wallet configurada:
```bash
npm run balance
```

### ¿Cómo limpiar órdenes activas colgadas?
Si apagas el servidor de forma brusca (o se corta la luz), es posible que queden ofertas activas de compra o venta en el Ledger de Ripple, inmovilizando tu capital. Puedes cancelarlas todas de un solo golpe ejecutando:
```bash
npm run cleanup
```

### Apagado Elegante (Graceful Shutdown)
* **Regla:** Nunca cierres la ventana de comandos directamente presionando la "X" si estás corriendo el bot en modo interactivo. Usa siempre **`Ctrl + C`**.
* **Razón:** Presionar `Ctrl + C` o ejecutar `pm2 stop` le da al bot un margen de 10-15 segundos para cancelar todas sus ofertas abiertas en el Ledger antes de desconectarse. Si cierras la ventana bruscamente, tus órdenes de venta o compra seguirán activas en la blockchain exponiendo tus fondos.

---

## 📝 Fichas y Recursos Recomendados

* Para entender cómo funciona el creador de mercado: [`docs/instances/001_helena_kyoto_sashimi.md`](file:///c:/Users/Dell/Desktop/xrpl-trading-bot/docs/instances/001_helena_kyoto_sashimi.md)
* Para entender la estrategia de acumulación: [`docs/DOROTHY_STRATEGY.md`](file:///c:/Users/Dell/Desktop/xrpl-trading-bot/docs/DOROTHY_STRATEGY.md)
* Para revisar advertencias adicionales de riesgo en arbitraje: [`docs/ARBITRAGE_RISK_WARNINGS.md`](file:///c:/Users/Dell/Desktop/xrpl-trading-bot/docs/ARBITRAGE_RISK_WARNINGS.md)

---

## 🚨 Protocolo ante Disparo del Fusible Térmico (API Fuse)

El **API Fuse** es tu salvaguarda automática contra bloqueos de IP y suspensiones de cuenta en Binance. Si se dispara, verás una alerta roja en el Dashboard Web y en los logs del bot, y todas las operaciones que involucren Binance se pausarán de forma preventiva.

### Síntomas:
- Mensajes en la terminal: `🚨 API FUSE TRIPPED (...) — LLAMADAS API REST BLOQUEADAS`
- En el Dashboard Web, el estado del fusible pasa de `CONECTADO` (verde) a `DISPARADO` (rojo) mostrando una cuenta atrás de cooldown.
- El botón rojo **"Restablecer Fusible"** se hace visible en el panel.

### Procedimiento de Recuperación:
1. **Mantén la calma:** El bot detiene de forma segura las consultas y transacciones hacia Binance para evitar que un baneo de IP se extienda o empeore.
2. **Revisar estado de Binance:** Verifica si Binance está experimentando problemas técnicos de red o mantenimiento en su portal: [Binance Announcements](https://binance.com/en/support/announcement).
3. **Revisar logs en `data/app_raw.log`**:
   - Si ves errores `HTTP 403` o `IP Ban`, tu clave de API o tu dirección IP han sido suspendidas temporalmente por Binance.
   - Si ves errores `HTTP 429` (Rate limit), significa que tienes demasiados procesos/instancias de Helena operando bajo la misma dirección IP pública.
4. **Esperar restauración automática:**
   - El fusible se restablecerá solo al finalizar la cuenta atrás.
   - Si el fusible se reconecta e inmediatamente se vuelve a disparar, la **escalada exponencial** duplicará el tiempo de espera (5 min ➔ 10 min ➔ 20 min ➔ 1 hora) para proteger tu IP.
5. **Restablecimiento manual:**
   - Si ya corregiste la causa del sobreconsumo (ej. detuviste otras instancias o actualizaste las API keys), puedes hacer clic en **"Restablecer Fusible"** en el Dashboard Web para forzar su reconexión de inmediato y reanudar el trading.

