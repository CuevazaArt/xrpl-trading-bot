# 🚀 Guía de Integración CEX para Usuarios (Helena Arbitrage Bot)

Esta guía paso a paso está diseñada para que cualquier usuario (incluso no técnico) pueda conectar de forma segura su exchange centralizado (CEX) preferido a **Helena** para realizar arbitrajes automatizados y coberturas sin riesgo de retiro de fondos.

---

## 🔒 1. Reglas de Oro de Seguridad (Leídas Obligatorias)

Antes de crear cualquier API Key en tu exchange, debes seguir estas tres reglas para garantizar que nadie (ni siquiera un atacante que comprometa tu servidor) pueda robar tus fondos:

1. **DESACTIVAR RETIROS (WITHDRAWALS)**: Al crear una API Key en cualquier CEX, verás una casilla que dice "Permitir retiros" o "Enable Withdrawals". **Déjala desactivada (unchecked).** Helena solo necesita permisos de "Lectura" (Read) y "Trading" (Spot/Futures).
2. **WHITELIST DE IP**: Configura tu clave API para que solo responda a solicitudes provenientes de la dirección IP de tu servidor VPS (donde corre Helena). Si alguien obtiene tus claves pero intenta usarlas desde otra IP, el CEX bloqueará la transacción al instante.
3. **MANTENER EL SECRETO**: La clave API secreta (API Secret) solo se muestra una vez al crearla. Cópiala directamente a tu archivo `.env` y nunca la compartas por chat ni la subas a GitHub.

---

## 2. Guías de Configuración por Exchange

Elige tu exchange y sigue los pasos:

### 🟡 Opción A: Binance (Por defecto)
Binance es el exchange con mayor liquidez global. Es el conector estándar de Helena.

1. **Crear API Key**:
   * Ve a tu perfil en Binance y selecciona **Gestión de API (API Management)**.
   * Haz clic en **Crear API** (elige "Generada por el sistema").
   * Ponle de etiqueta `Helena_Arbitrage`.
2. **Configurar Restricciones**:
   * Haz clic en **Editar restricciones** (Edit restrictions).
   * Activa: **Habilitar Lectura** (Enable Reading).
   * Activa: **Habilitar Spot y Margin Trading** (Enable Spot & Margin Trading).
   * 🚫 Asegúrate de que **Habilitar Retiros** esté **DESACTIVADO**.
   * Selecciona "Restringir el acceso solo a IPs de confianza" e introduce la IP pública de tu servidor.
3. **Guardar en Helena**:
   * Copia tu API Key y tu API Secret.
   * Abre el archivo `.env` de Helena y rellena las variables:
     ```env
     BINANCE_API_KEY=tu_api_key_de_binance_aqui
     BINANCE_API_SECRET=tu_api_secret_de_binance_aqui
     BINANCE_BASE_URL=https://api.binance.com
     ```

---

### 🟢 Opción B: OKX
Ideal por su modelo de "Cuenta Unificada" que permite usar todo tu capital de margen de forma óptima.

1. **Crear API Key**:
   * Ve al menú de configuración en la esquina superior derecha y selecciona **API**.
   * Haz clic en **Crear clave API**.
   * Escribe el nombre `Helena_OKX`.
   * **Muy importante**: OKX te pedirá un **Passphrase** (frase de contraseña) específica para esta API Key. Elígela y apúntala, la necesitarás en el `.env`.
2. **Configurar Permisos**:
   * Selecciona los permisos: **Lectura** (Read) y **Operar** (Trade).
   * 🚫 Deja sin marcar el permiso de **Retirar** (Withdraw).
   * Vincula la dirección IP de tu VPS en el campo correspondiente.
3. **Guardar en Helena**:
   * Copia el API Key, Secret y añade el Passphrase a tu archivo `.env`.

---

### 🔵 Opción C: Bybit
El preferido por traders que operan futuros perpetuos de alta volatilidad.

1. **Crear API Key**:
   * Ve al panel de usuario y entra en **API**.
   * Haz clic en **Crear nueva clave** (Claves API generadas por el sistema).
   * Asigna el nombre `Helena_Bybit`.
   * Selecciona: "Transacción API" (API Transaction).
2. **Configurar Permisos**:
   * Vincula la IP de tu VPS.
   * En los permisos, marca: **Contrato** (Active orders / Position) y **Spot** (Trade).
   * 🚫 Asegúrate de que la casilla **Transferencia de activos** (Asset Transfer / Withdrawals) esté **desactivada**.
3. **Guardar en Helena**:
   * Copia la API Key y API Secret a tu `.env`.

---

### 🟣 Opción D: Kraken
El exchange con mejor reputación de seguridad física y cumplimiento regulatorio en EE. UU. y Europa.

1. **Crear API Key**:
   * Entra en tu cuenta de Kraken, ve a tu Perfil y selecciona **Seguridad > API**.
   * Haz clic en **Añadir clave API** (Add API Key).
   * Escribe el nombre `Helena_Kraken`.
2. **Configurar Permisos**:
   * Marca las casillas: **Query Funds** (Consultar balances), **Query Open/Closed Orders** (Consultar órdenes) y **Modify Orders** (Colocar y cancelar órdenes).
   * 🚫 Asegúrate de que **Withdraw Funds** (Retirar fondos) esté **DESACTIVADO**.
   * Configura la restricción de IP con la IP pública de tu VPS.
3. **Guardar en Helena**:
   * Copia el API Key y la clave privada de API generada (Private Key) a tu `.env`.

---

## 3. Instrucciones de Despliegue para Usuarios No Técnicos

Una vez configuradas las API Keys en tu exchange, sigue estos sencillos pasos para iniciar a **Helena**:

1. **Subir los Archivos al Servidor**:
   * Sube la carpeta del bot Helena a tu servidor VPS o computadora local.
2. **Configurar el archivo de entorno (`.env`)**:
   * En la carpeta raíz del proyecto verás un archivo llamado `.env.example`.
   * Renombra el archivo a simplemente `.env` (en Windows: clic derecho -> cambiar nombre; en Linux: `mv .env.example .env`).
   * Abre el archivo `.env` con cualquier editor de texto (como Notepad o VS Code) y pega las API Keys del paso anterior.
3. **Iniciar el bot**:
   * Abre una consola de comandos (Terminal o PowerShell) en la carpeta del bot.
   * Ejecuta el bot en modo de simulación segura (Paper Trading) para verificar que se conecta bien al CEX y lee tus balances sin arriesgar dinero:
     ```bash
     node dist/index.js --paper-trading --skip-swap
     ```
   * Monitorea la consola. Deberías ver líneas que confirman la conexión exitosa al CEX y la lectura de balances:
     ```log
     18:02:49 INF CEXConne Cargado adaptador CEX activo: 'binance'
     18:02:49 INF CEX:Bina API Keys OK — Cargando balances de XRP y USDT...
     ```
   * Si todo está correcto, el bot iniciará su carrusel de trading seguro.
