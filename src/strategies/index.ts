import { IStrategy } from './IStrategy.js';
import { XRPLMarketMakerStrategy } from './marketMaker.js';
import { XRPLDorothyStrategy } from './dorothy.js';
import { XRPLElphabaStrategy } from './elphaba.js';
import { XRPLBaseLouiseStrategy } from './louise.js';
import { XRPLBaseAntiLouiseStrategy } from './anti_louise.js';
import { XRPLMashaStrategy } from './masha.js';
import { XRPLThusneldaStrategy } from './thusnelda.js';
import { XRPLAgarthaStrategy } from './agartha.js';

export * from './IStrategy.js';
export * from './marketMaker.js';
export * from './dorothy.js';
export * from './elphaba.js';
export * from './louise.js';
export * from './anti_louise.js';
export * from './masha.js';
export * from './thusnelda.js';
export * from './agartha.js';

/**
 * Factory para instanciar la estrategia elegida según la configuración
 */
export function createStrategy(strategyName: string): IStrategy {
  const name = strategyName.toLowerCase().trim();
  switch (name) {
    case 'market_maker':
      return new XRPLMarketMakerStrategy();
    case 'dorothy':
      return new XRPLDorothyStrategy();
    case 'elphaba':
      return new XRPLElphabaStrategy();
    case 'louise':
      return new XRPLBaseLouiseStrategy();
    case 'anti_louise':
      return new XRPLBaseAntiLouiseStrategy();
    case 'masha':
      return new XRPLMashaStrategy();
    case 'thusnelda':
      return new XRPLThusneldaStrategy();
    case 'agartha':
      return new XRPLAgarthaStrategy();
    default:
      console.warn(`[Factory] Estrategia no reconocida: '${strategyName}'. Cargando 'market_maker' por defecto.`);
      return new XRPLMarketMakerStrategy();
  }
}
