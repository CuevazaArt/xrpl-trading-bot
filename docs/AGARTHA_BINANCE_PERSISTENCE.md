# Guía de Persistencia y Despliegue de Agartha Binance Spot

Esta guía detalla el procedimiento para configurar, ejecutar de forma persistente y migrar la instancia aislada del bot **Agartha** en Binance Spot.

---

## 🚀 Despliegue Persistente (PM2)

Para garantizar que el bot siga ejecutándose en segundo plano y se reinicie automáticamente ante fallos del sistema o del servidor, se recomienda utilizar el gestor de procesos **PM2**.

### 1. Requisitos Previos
* Tener instalado Node.js (v18 o superior).
* Instalar PM2 de forma global:
  ```bash
  npm install -g pm2
  ```

### 2. Iniciar el Proceso
Primero compile el proyecto y luego inicie el runner con PM2:
```bash
npm run build
pm2 start dist/binanceAgarthaRunner.js --name "helena-agartha-binance"
```

### 3. Monitoreo y Logs
* Ver el estado del bot en tiempo real:
  ```bash
  pm2 status
  ```
* Ver los logs continuos:
  ```bash
  pm2 logs helena-agartha-binance
  ```
* Configurar inicio automático con el sistema:
  ```bash
  pm2 startup
  pm2 save
  ```

---

## 💾 Persistencia de Datos y Estados

El bot almacena los estados de cada posición abierta (pico de precio, cantidad comprada, precio de entrada y estado del trailing) en la base de datos persistente:
* **Producción**: Guardado en la base de datos SQLite en `data/helena.db`.
* **Desarrollo / Tests**: Guardado en `data/db.json`.

Dado que todos los datos están en `data/helena.db`, **el bot puede apagarse y encenderse en cualquier momento sin perder la noción de sus posiciones abiertas**. Al arrancar, leerá el último estado de la base de datos y retomará el seguimiento (Trailing Stop) del precio exacto donde se quedó.

---

## ✈️ Migración a Otro Servidor (Retomar Sesión)

Si necesitas mudar el bot a otra máquina o VPS sin perder el historial ni cerrar posiciones activas, sigue estos pasos:

1. **Compromiso de ticks**: Detén el proceso en el servidor de origen:
   ```bash
   pm2 stop helena-agartha-binance
   ```
2. **Copiar Base de Datos**: Copia el directorio `data/` completo (que contiene `helena.db`) de tu servidor actual. **Este archivo contiene todo el estado de la sesión activa.**
3. **Transferir Código y Configuración**: Copia los archivos del bot, incluyendo tu `.env` con las credenciales de la subcuenta de Binance.
4. **Pegar en el Servidor de Destino**:
   * Pega la carpeta del bot en la nueva máquina.
   * Coloca el archivo `helena.db` copiado en el directorio `data/` del nuevo servidor.
5. **Iniciar en Destino**:
   ```bash
   npm install
   npm run build
   pm2 start dist/binanceAgarthaRunner.js --name "helena-agartha-binance"
   ```
   El bot leerá `data/helena.db` y retomará el monitoreo de los mismos activos en el punto exacto de forma persistente.

---

## 🛡️ Manejo de Excepciones y Rate Limits (Monitoreo Continuo)

* **Excepciones por Símbolo**: La ejecución de cada tick está encapsulada a nivel individual de símbolo. Si el token `TA` sufre una excepción de red o de API (ej. saldo insuficiente para ese par), el error se captura y se reporta en logs, permitiendo que `FARM`, `POND` y los demás símbolos sigan operando normalmente.
* **Gobernador de Pesos (Weight Governor)**: Cada solicitud se evalúa antes de ser enviada. Si el consumo de API se aproxima al 80% (Zona Amarilla), introduce retardos automáticos. Si cruza el 80% (Zona Roja), bloquea temporalmente las peticiones REST para evitar bloqueos por parte del firewall de Binance.
* **Consulta Masiva**: Se realiza una única petición de cotización para todos los tokens de forma unificada en cada tick, consumiendo únicamente 2 de peso, reduciendo el consumo global a menos del 1% del límite total de Binance.

---

## 💰 Capital Mínimo y Control de Posiciones

* **Mecanismo de Control de Capital (`AGARTHA_MAX_CONCURRENT_POSITIONS`)**:
  Para evitar que el bot intente abrir posiciones en todos los activos del catálogo Alpha simultáneamente y agote tu liquidez, la estrategia implementa un control de límite concurrentes. Si el bot ya tiene $M$ posiciones activas (configuradas por `AGARTHA_MAX_CONCURRENT_POSITIONS`), bloqueará cualquier nueva orden de compra (Trailing Entry) hasta que liquide alguna de las activas.
* **Fórmula de Capital Requerido**:
  $$\text{Capital Mínimo} = (P_{\text{max}} \times \text{Nocional}) \times 1.05$$
  Donde:
  * $P_{\text{max}}$ es el límite configurado en `AGARTHA_MAX_CONCURRENT_POSITIONS` (por ejemplo, `30`).
  * $\text{Nocional}$ es la inversión fija por posición (por ejemplo, `10.0` USDT).
  * El factor `1.05` añade un buffer del 5% para comisiones de exchange y deslizamiento de precios.
* **Subcuenta Aislada**:
  Se exige la creación de una subcuenta dedicada en Binance. Las claves API vinculadas no deben tener permisos de retiro y deben estar restringidas por IP. Esto garantiza la seguridad absoluta del balance principal de tu cuenta.
