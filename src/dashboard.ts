import http from 'http';
import { db } from './db.js';
import { config } from './config.js';

export class XRPLDashboard {
  private port: number = config.dashboardPort;
  private server: http.Server | null = null;
  
  // Variables compartidas con el bot para reportar el estado en vivo
  private state = {
    walletAddress: 'No inicializada',
    xrpBalance: '0',
    usdBalance: '0',
    activeBuySeq: 'Ninguna',
    activeSellSeq: 'Ninguna',
    midPrice: '0.0000',
    buyTarget: '0.0000',
    sellTarget: '0.0000',
    strategyName: 'Ninguna',
    activeRungs: 'N/A',
    botStatus: 'Iniciando...'
  };

  updateState(newState: Partial<typeof this.state>) {
    this.state = { ...this.state, ...newState };
  }


  start() {
    this.server = http.createServer((req, res) => {
      // Autenticación Bearer Token (si está configurado)
      if (config.dashboardToken) {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        // También aceptar token como query param para navegadores
        const urlToken = new URL(req.url || '/', `http://localhost:${this.port}`).searchParams.get('token') || '';
        
        if (token !== config.dashboardToken && urlToken !== config.dashboardToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized. Provide DASHBOARD_TOKEN via Authorization: Bearer <token> header or ?token= query param.' }));
          return;
        }
      }

      // 1. Endpoint API para retornar el estado en formato JSON
      if (req.url?.startsWith('/api/status') && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        const maskedAddress = this.maskAddress(this.state.walletAddress);
        const statusData = {
          ...this.state,
          walletAddress: maskedAddress,
          transactions: db.getTransactions().reverse(), // Últimas primero
          balancesHistory: db.getBalancesHistory()
        };
        res.end(JSON.stringify(statusData));
        return;
      }

      // 2. Servir la interfaz web principal HTML/CSS/JS
      if ((req.url === '/' || req.url?.startsWith('/?')) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getHtmlContent());
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    this.server.listen(this.port, () => {
      // No usamos logger aquí para no crear dependencia circular
      console.log(`[DASHBOARD] Servidor web iniciado en: http://localhost:${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log('[DASHBOARD] Servidor web apagado.');
    }
  }

  /**
   * Enmascara la dirección de wallet para mostrar solo primeros y últimos 4 caracteres.
   */
  private maskAddress(address: string): string {
    if (!address || address.length < 10 || address === 'No inicializada') return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XRPL Bot Dashboard</title>
  <!-- Google Fonts: Outfit -->
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f111a 0%, #151829 100%);
      --panel-bg: rgba(26, 29, 50, 0.6);
      --border-color: rgba(255, 255, 255, 0.08);
      --accent-color: #5b6df6;
      --accent-glow: rgba(91, 109, 246, 0.3);
      --success-color: #00e676;
      --error-color: #ff1744;
      --text-main: #ffffff;
      --text-muted: #8b92b6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', sans-serif;
    }

    body {
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
      overflow-x: hidden;
    }

    .container {
      width: 100%;
      max-width: 1200px;
      display: flex;
      flex-direction: column;
      gap: 30px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 20px;
    }

    header h1 {
      font-size: 2.2rem;
      font-weight: 800;
      background: linear-gradient(90deg, #5b6df6, #00e676);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header .status-tag {
      background: rgba(0, 230, 118, 0.15);
      border: 1px solid var(--success-color);
      color: var(--success-color);
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 0.9rem;
      font-weight: 600;
      letter-spacing: 0.5px;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(0, 230, 118, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0); }
    }

    /* Grid Layout */
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
    }

    /* Panel Card Estilo Premium (Glassmorphism) */
    .card {
      background: var(--panel-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 30px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
      transition: transform 0.3s ease, border-color 0.3s ease;
    }

    .card:hover {
      transform: translateY(-5px);
      border-color: rgba(91, 109, 246, 0.3);
    }

    .card h2 {
      font-size: 1.2rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .balance-value {
      font-size: 3rem;
      font-weight: 800;
      line-height: 1;
    }

    .balance-symbol {
      font-size: 1.2rem;
      font-weight: 600;
      color: var(--accent-color);
      margin-left: 5px;
    }

    .info-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
    }

    .info-row span:first-child {
      color: var(--text-muted);
      font-size: 0.95rem;
    }

    .info-row span:last-child {
      font-weight: 600;
    }

    .active-seq {
      background: var(--accent-color);
      color: var(--text-main);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 0.85rem;
    }

    /* Logs/Historial Panel */
    .history-card {
      grid-column: 1 / -1;
    }

    .logs-table-wrapper {
      max-height: 350px;
      overflow-y: auto;
      border-radius: 12px;
      border: 1px solid var(--border-color);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-muted);
      font-weight: 600;
      padding: 14px 20px;
      font-size: 0.9rem;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 14px 20px;
      font-size: 0.95rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.01);
    }

    .status-success { color: var(--success-color); font-weight: 600; }
    .status-failed { color: var(--error-color); font-weight: 600; }

    .tag {
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .tag-buy { background: rgba(0, 230, 118, 0.12); color: var(--success-color); }
    .tag-sell { background: rgba(255, 23, 68, 0.12); color: var(--error-color); }
    .tag-cancel { background: rgba(255, 255, 255, 0.1); color: var(--text-muted); }
    .tag-trust { background: rgba(91, 109, 246, 0.15); color: #8c9eff; }

    .address-box {
      font-family: monospace;
      color: var(--text-muted);
      background: rgba(0, 0, 0, 0.2);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.9rem;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>XRPL Trading Bot</h1>
        <p style="color: var(--text-muted); margin-top: 5px;">Panel de Control y Monitorización de Estrategia</p>
      </div>
      <div class="status-tag" id="strategy-tag" style="background: rgba(91, 109, 246, 0.15); border: 1px solid var(--accent-color); color: var(--text-main);">Cargando Estrategia...</div>
    </header>

    <div class="dashboard-grid">
      <!-- Card Balances -->
      <div class="card">
        <h2>Billetera y Fondos</h2>
        <div class="address-box" id="wallet-address">Cargando...</div>
        <div style="margin-top: 10px;">
          <p style="color: var(--text-muted); font-size: 0.85rem;">Balance de XRP</p>
          <div class="balance-value"><span id="xrp-balance">0.00</span><span class="balance-symbol">XRP</span></div>
        </div>
        <div>
          <p style="color: var(--text-muted); font-size: 0.85rem;">Balance de USD</p>
          <div class="balance-value" style="color: #00e676;"><span id="usd-balance">0.00</span><span class="balance-symbol" style="color: #00e676;">USD</span></div>
        </div>
      </div>

      <!-- Card Estado DEX -->
      <div class="card">
        <h2>Estado de Libros y Órdenes</h2>
        <div class="info-list">
          <div class="info-row">
            <span>Estrategia Activa:</span>
            <span id="strategy-name" style="font-weight: bold; color: var(--accent-color);">Cargando...</span>
          </div>
          <div class="info-row">
            <span>Estado del Bot:</span>
            <span id="bot-status" style="color: var(--text-main);">Cargando...</span>
          </div>
          <div class="info-row">
            <span>Peldaños (DCA Rungs):</span>
            <span id="active-rungs" style="color: var(--success-color); font-weight: bold;">N/A</span>
          </div>
          <div class="info-row">
            <span>Precio Referencia (Oráculo):</span>
            <span id="mid-price" style="font-weight: bold; color: var(--text-main);">0.0000 USD</span>
          </div>
          <div class="info-row">
            <span>Objetivo Compra (Bid):</span>
            <span id="buy-target" style="color: var(--success-color);">0.0000 USD</span>
          </div>
          <div class="info-row">
            <span>Objetivo Venta (Ask):</span>
            <span id="sell-target" style="color: var(--error-color);">0.0000 USD</span>
          </div>
          <div class="info-row">
            <span>Orden Compra Activa (DEX):</span>
            <span id="active-buy" class="active-seq">Ninguna</span>
          </div>
          <div class="info-row">
            <span>Orden Venta Activa (DEX):</span>
            <span id="active-sell" class="active-seq" style="background: var(--error-color);">Ninguna</span>
          </div>
        </div>
      </div>

      <!-- Card Historial (Tabla) -->
      <div class="card history-card">
        <h2>Historial de Actividad del Bot</h2>
        <div class="logs-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Fecha/Hora</th>
                <th>Operación</th>
                <th>Hash Transacción</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody id="logs-body">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted);">Cargando historial...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    async function updateDashboard() {
      try {
        // Pasar el token de autenticación si está presente en la URL
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || '';
        const apiUrl = token ? '/api/status?token=' + encodeURIComponent(token) : '/api/status';
        const response = await fetch(apiUrl);
        const data = await response.json();

        // Actualizar Balances e Información
        document.getElementById('wallet-address').textContent = data.walletAddress;
        document.getElementById('xrp-balance').textContent = parseFloat(data.xrpBalance).toFixed(4);
        document.getElementById('usd-balance').textContent = parseFloat(data.usdBalance).toFixed(4);
        
        // Estrategia y Estado de Bots
        document.getElementById('strategy-tag').textContent = data.strategyName.toUpperCase();
        document.getElementById('strategy-name').textContent = data.strategyName;
        document.getElementById('bot-status').textContent = data.botStatus;
        document.getElementById('active-rungs').textContent = data.activeRungs;

        // Estado DEX
        document.getElementById('mid-price').textContent = parseFloat(data.midPrice).toFixed(4) + ' USD';
        document.getElementById('buy-target').textContent = parseFloat(data.buyTarget).toFixed(4) + ' USD';
        document.getElementById('sell-target').textContent = parseFloat(data.sellTarget).toFixed(4) + ' USD';

        document.getElementById('active-buy').textContent = data.activeBuySeq;
        document.getElementById('active-sell').textContent = data.activeSellSeq;

        // Historial
        const tbody = document.getElementById('logs-body');
        if (data.transactions && data.transactions.length > 0) {
          tbody.innerHTML = data.transactions.map(tx => {
            const date = new Date(tx.timestamp).toLocaleTimeString();
            let tagClass = 'tag';
            if (tx.type.toLowerCase().includes('buy')) tagClass += ' tag-buy';
            else if (tx.type.toLowerCase().includes('sell')) tagClass += ' tag-sell';
            else if (tx.type.toLowerCase().includes('cancel')) tagClass += ' tag-cancel';
            else if (tx.type.toLowerCase().includes('trust')) tagClass += ' tag-trust';
            
            const statusClass = tx.status === 'tesSUCCESS' ? 'status-success' : 'status-failed';
            const shortHash = tx.hash ? tx.hash.substring(0, 16) + '...' : 'N/A';
            const linkHash = tx.hash 
              ? '<a href="https://test.bithomp.com/explorer/' + tx.hash + '" target="_blank" style="color: #5b6df6; text-decoration: none;">' + shortHash + '</a>' 
              : 'N/A';

            return '<tr>' +
              '<td>' + date + '</td>' +
              '<td><span class="' + tagClass + '">' + tx.type + '</span></td>' +
              '<td>' + linkHash + '</td>' +
              '<td class="' + statusClass + '">' + tx.status + '</td>' +
              '</tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Sin transacciones registradas todavía.</td></tr>';
        }
      } catch (error) {
        console.error('Error al actualizar el dashboard:', error);
      }
    }

    // Actualizar cada 2 segundos
    setInterval(updateDashboard, 2000);
    updateDashboard();
  </script>
</body>
</html>

`;
  }
}
