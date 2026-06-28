import { JSONDatabase } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('VenueExpansion');

export interface ExpansionCandidate {
  id: string;
  name: string;
  type: 'DEX' | 'CEX';
  credentialsRequired: string[];
  minimumFunding: string;
  description: string;
}

export interface ExpansionState {
  activeVenues: string[];
  currentPhaseStartTime: string;
  phaseWatchdogHours: number;
  upgradePrompted: boolean;
}

export const EXPANSION_CANDIDATES: ExpansionCandidate[] = [
  {
    id: 'binance',
    name: 'Binance CEX Adapter',
    type: 'CEX',
    credentialsRequired: ['BINANCE_API_KEY', 'BINANCE_API_SECRET'],
    minimumFunding: '100 XRP / 100 USDT',
    description: 'Permite arbitrar contra el libro de órdenes spot de mayor volumen del mundo.'
  },
  {
    id: 'okx',
    name: 'OKX CEX Adapter',
    type: 'CEX',
    credentialsRequired: ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'],
    minimumFunding: '150 XRP / 150 USDT',
    description: 'Habilita arbitraje con cuenta unificada (Unified Account) y spreads competitivos.'
  },
  {
    id: 'safe',
    name: 'Safe Smart Account (ERC-4337)',
    type: 'DEX',
    credentialsRequired: ['SAFE_SESSION_KEY', 'EVM_RPC_URL'],
    minimumFunding: '0.05 ETH / 200 USDC',
    description: 'Habilita el arbitraje descentralizado multired (L2s) con gas patrocinado.'
  }
];

export class VenueExpansionManager {
  private db: JSONDatabase;
  private state: ExpansionState;

  constructor(db: JSONDatabase) {
    this.db = db;
    this.state = this.loadState();
  }

  /**
   * Carga el estado de expansión desde la DB o lo inicializa por defecto.
   */
  private loadState(): ExpansionState {
    const saved = this.db.getCustomData('expansionState');
    if (saved) {
      return saved as ExpansionState;
    }

    const defaultState: ExpansionState = {
      activeVenues: ['xrpl_dex', 'mock_cex'],
      currentPhaseStartTime: new Date().toISOString(),
      phaseWatchdogHours: 24, // 24 horas por defecto
      upgradePrompted: false
    };

    this.db.saveCustomData('expansionState', defaultState);
    return defaultState;
  }

  /**
   * Guarda el estado actual en la DB.
   */
  private saveState(): void {
    this.db.saveCustomData('expansionState', this.state);
  }

  /**
   * Evalúa si Helena califica para expandirse a un nuevo venue o nodo.
   */
  async evaluateExpansionTick(forceShortWindowForTest = false): Promise<void> {
    if (this.state.upgradePrompted) {
      return; // Ya se le solicitó el upgrade al usuario
    }

    const startTime = new Date(this.state.currentPhaseStartTime).getTime();
    const now = Date.now();
    const elapsedMs = now - startTime;
    const requiredMs = forceShortWindowForTest
      ? 5000 // 5 segundos en tests/simulación corta
      : this.state.phaseWatchdogHours * 60 * 60 * 1000;

    if (elapsedMs < requiredMs) {
      return; // El período de monitoreo aún está activo
    }

    // 1. Obtener anomalías ocurridas desde el inicio de la fase
    const anomalies = this.db.getAnomalies() || [];
    const recentAnomalies = anomalies.filter(anom => {
      const anomTime = new Date(anom.timestamp).getTime();
      return anomTime >= startTime;
    });

    if (recentAnomalies.length > 0) {
      // Hubo errores en esta fase: reiniciar el temporizador para asegurar estabilidad
      log.warn(`⚠️ Estabilidad de fase interrumpida por ${recentAnomalies.length} anomalía(s). Reiniciando ventana de prueba de ${this.state.phaseWatchdogHours}h...`);
      this.state.currentPhaseStartTime = new Date().toISOString();
      this.saveState();
      return;
    }

    // 2. Proponer el siguiente candidato disponible
    const nextCandidate = EXPANSION_CANDIDATES.find(c => !this.state.activeVenues.includes(c.id));
    if (!nextCandidate) {
      log.info('🎉 ¡Felicidades! Se han integrado todos los venues y nodos disponibles en el ecosistema.');
      return;
    }

    // 3. Emitir invitación interactiva de expansión al usuario
    this.promptUpgrade(nextCandidate);
    this.state.upgradePrompted = true;
    this.saveState();
  }

  /**
   * Imprime en consola la tarjeta de invitación con los requisitos necesarios.
   */
  private promptUpgrade(c: ExpansionCandidate): void {
    log.warn('=====================================================================');
    log.warn(`🚀 EXPANSIÓN RECOMENDADA: ${c.name.toUpperCase()}`);
    log.warn('=====================================================================');
    log.warn(`Helena ha operado de forma 100% estable en el círculo actual.`);
    log.warn(`Próximo venue sugerido: ${c.description}`);
    log.warn(`Requisitos de Fondeo Mínimo: ${c.minimumFunding}`);
    log.warn(`Credenciales a añadir en el archivo .env:`);
    c.credentialsRequired.forEach(cred => {
      log.warn(`   - ${cred}`);
    });
    log.warn('Una vez configuradas las variables, reinicia el bot para activarlo.');
    log.warn('=====================================================================');
  }

  /**
   * Permite al usuario o al sistema activar manualmente el siguiente venue.
   */
  activateNextVenue(candidateId: string): void {
    const candidate = EXPANSION_CANDIDATES.find(c => c.id === candidateId);
    if (!candidate) {
      throw new Error(`Candidato de expansión no reconocido: ${candidateId}`);
    }

    if (!this.state.activeVenues.includes(candidateId)) {
      this.state.activeVenues.push(candidateId);
    }
    
    this.state.currentPhaseStartTime = new Date().toISOString();
    this.state.upgradePrompted = false;
    this.saveState();
    log.info(`✅ Venue '${candidateId}' añadido. Iniciando nueva fase de prueba de ${this.state.phaseWatchdogHours}h...`);
  }

  getActiveVenues(): string[] {
    return this.state.activeVenues;
  }

  isUpgradePrompted(): boolean {
    return this.state.upgradePrompted;
  }
}
