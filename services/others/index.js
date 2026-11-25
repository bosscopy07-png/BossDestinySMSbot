// services/others/index.js — factory wiring the OTHERS module to the real store/provider/wallet
import { OthersStore } from './OthersStore.js';
import { OthersProvider } from './OthersProvider.js';
import { OthersPricing } from './OthersPricing.js';
import { OthersManager } from './OthersManager.js';
import { OthersPolling } from './OthersPolling.js';

export function createOthersService({ walletService, notifier = null, provider = new OthersProvider(), store = new OthersStore() } = {}) {
    const pricing = new OthersPricing({ markupUsd: process.env.OTHERS_MARKUP_USD ? parseFloat(process.env.OTHERS_MARKUP_USD) : undefined });
    const manager = new OthersManager({ store, provider, wallet: walletService, pricing, notifier });
    const polling = new OthersPolling({ manager, store });
    return { manager, polling, store, provider, pricing };
}
export { OthersManager, OthersPolling, OthersProvider, OthersPricing, OthersStore };
