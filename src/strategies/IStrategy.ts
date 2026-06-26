import { Client, Wallet } from 'xrpl';
import { XRPLOrderManager } from '../orderManager.js';
import { XRPLDashboard } from '../dashboard.js';

export interface IStrategy {
  name: string;
  init(
    client: Client,
    wallet: Wallet,
    orderManager: XRPLOrderManager,
    dashboard: XRPLDashboard
  ): Promise<void>;
  tick(currentLedger: number, marketPrice: number): Promise<void>;
  cleanup(): Promise<void>;
}
