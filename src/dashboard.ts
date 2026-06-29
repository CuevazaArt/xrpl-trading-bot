import http from 'http';
import fs from 'fs';
import path from 'path';
import { db } from './db.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { apiFuse } from './cexAdapters/apiFuse.js';
import { weightGovernor } from './cexAdapters/weightGovernor.js';
import { DASHBOARD_HTML } from './dashboardTemplate.js';

const log = createLogger('Dashboard');

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
          balancesHistory: db.getBalancesHistory(),
          apiFuse: apiFuse.getStatus(),
          weightGovernor: weightGovernor.getStatus()
        };
        res.end(JSON.stringify(statusData));
        return;
      }

      // 1.2 Endpoint API para resetear manualmente el fusible
      if (req.url?.startsWith('/api/api-fuse/reset') && req.method === 'POST') {
        apiFuse.manualReset();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, message: 'API Fuse restablecido manualmente.' }));
        return;
      }

      // 1.1 Endpoint API para retornar las últimas líneas de logs raw
      if (req.url?.startsWith('/api/logs') && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        
        try {
          const logPath = path.join(process.cwd(), 'data', 'app_raw.log');
          if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            const lastLines = lines.slice(-40); // Últimos 40 logs
            res.end(JSON.stringify({ logs: lastLines }));
          } else {
            res.end(JSON.stringify({ logs: ['El bot aún no ha generado registros en app_raw.log.'] }));
          }
        } catch (err) {
          res.end(JSON.stringify({ logs: [`Error leyendo logs: ${(err as any).message}`] }));
        }
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
      log.info(`Servidor web iniciado en: http://localhost:${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      log.info('Servidor web apagado.');
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
    return DASHBOARD_HTML;
  }
}
