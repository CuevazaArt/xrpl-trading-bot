# ⚠️ Advertencias de Riesgo y Errores a Evitar en el Arbitraje Algorítmico

Este documento detalla los fallos técnicos, operativos y de lógica de mercado que pueden provocar pérdidas de fondos, penalizaciones de red o degradación del rendimiento de **Helena** al operar arbitrajes multi-venue.

---

## 1. Riesgos de Ejecución Asimétrica (Execution Gaps)

El arbitraje clásico de dos patas consiste en comprar un activo en un exchange (DEX) y venderlo instantáneamente en otro (CEX o DEX) para capturar el diferencial.

### 🔴 El Error: Envío no síncrono de órdenes ("Leg-Lock")
*   **El Escenario**: El bot identifica un spread favorable. Envía una orden de compra en el DEX (red on-chain con tiempo de bloque de 3s o más) y envía en paralelo la orden de venta en el CEX. La orden del CEX se llena de inmediato, pero la transacción del DEX es rechazada (por deslizamiento o falta de liquidez).
*   **Consecuencia**: El bot se queda en una posición desequilibrada (ej. corto en XRP en el CEX sin haber comprado en el DEX), expuesto al movimiento direccional del mercado.
*   **Cómo evitarlo**:
    *   **Ejecución secuencial con confirmación**: La orden de la segunda pata (usualmente la de mayor velocidad/CEX) solo debe enviarse *después* de que la primera pata (la de red lenta/on-chain) confirme el hash de transacción y el fill exitoso.
    *   **Modo Simulado / Dry-Run**: Probar el comportamiento de reconexión y cancelaciones con saldo de papel antes de activar saldo real.

---

## 2. El Impuesto Silencioso: Comisiones de Gas y Red (Gas Guzzling)

### 🔴 El Error: Ignorar los costos de transacción fijos en el cálculo de spreads
*   **El Escenario**: El bot detecta una oportunidad de arbitraje de $0.05 USD por XRP. Ejecuta un swap en Arbitrum que cuesta $0.30 USD en gas de red, y liquida en el CEX pagando comisiones del 0.1%.
*   **Consecuencia**: Pérdida neta de dinero por cada operación realizada.
*   **Cómo evitarlo**:
    *   Implementar un **Fee-Aware Spread Floor** (límite de rentabilidad en base a fees) que sume todos los costos fijos estimados de transacción (fees de red on-chain + fees del creador/tomador del CEX) al spread mínimo requerido antes de disparar el trade.

---

## 3. MEV y Frontrunning (Ataques Sandwich)

Las transacciones enviadas a mempools públicas en redes EVM (como Arbitrum, Polygon o Ethereum) son visibles para bots de búsqueda de valor extraíble de mineros/validadores (MEV).

### 🔴 El Error: Usar RPCs públicos e ignorar límites de deslizamiento (Slippage)
*   **El Escenario**: El bot envía una transacción de swap con un slippage muy generoso (ej. 2% o 5%) a través de una mempool pública. Un bot de MEV detecta la transacción, inserta una orden de compra justo antes (frontrun) elevando el precio, permite que el bot de Helena compre a un precio desfavorable y luego vende inmediatamente después (backrun).
*   **Consecuencia**: Helena compra a un precio artificialmente caro, absorbiendo pérdidas en beneficio del bot de MEV.
*   **Cómo evitarlo**:
    *   **Deslizamiento Estricto**: Mantener el límite de deslizamiento (`slippagePct`) en valores muy bajos (máximo 0.5%).
    *   **Servicios de RPC Privados**: Enviar transacciones a través de servicios que evitan mempools públicas (como Flashbots Protect en redes EVM o Jito en Solana).

---

## 4. Oráculos Estancados o Desfasados (Stale Oracles)

El cálculo del arbitraje requiere comparar el precio local del DEX contra el precio de referencia mundial (oráculo).

### 🔴 El Error: Usar datos de precios con caché expirada o baja frecuencia
*   **El Escenario**: La API de CryptoCompare o Binance falla temporalmente. El bot de Helena continúa leyendo el último precio guardado de $1.04 USD. Mientras tanto, el precio real de mercado en exchanges mundiales se desploma a $0.98 USD. El DEX local refleja este desplome, pero Helena cree ver una oportunidad de compra masiva al comparar el precio local de $0.98 USD contra el oráculo desfasado de $1.04 USD.
*   **Consecuencia**: El bot compra XRP que está cayendo de precio, creyendo erróneamente que está ganando dinero por arbitraje (operación tóxica).
*   **Cómo evitarlo**:
    *   Aplicar **Halt-on-Failure**: Si las fuentes del oráculo reportan menos de 2 fuentes saludables, o si el timestamp de la última actualización exitosa excede los 30-60 segundos, pausar el trading y retornar precio `0`.

---

## 5. Acumulación de Objetos en Cuenta (OwnerCount y Reservas)

En redes como XRPL, cada orden activa y trustline incrementa el requisito de reserva de saldo bloqueado en tu cuenta (OwnerCount).

### 🔴 El Error: No cancelar órdenes anteriores antes de enviar reemplazos
*   **El Escenario**: El bot genera nuevas órdenes limitadas pasivas en cada ledger sin asegurarse de que las anteriores fueron canceladas con éxito.
*   **Consecuencia**: Acumulación de OwnerCount. Eventualmente el balance libre de XRP cae por debajo de la reserva mínima obligatoria, inhabilitando la cuenta para operar y lanzando errores `tecINSUFFICIENT_RESERVE`.
*   **Cómo evitarlo**:
    *   Seguir el patrón **Cancel-Before-Replace**: Cancelar proactivamente todas las ofertas activas registradas en `account_offers` antes de proponer nuevas órdenes en el siguiente bloque.
