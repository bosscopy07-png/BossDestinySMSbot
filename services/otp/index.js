import SMSProviderManager from '../sms/index.js';
import RetryEngine from './RetryEngine.js';
import SessionManager from './SessionManager.js';
import WalletService from '../wallet/index.js';

// Initialize services
const providerManager = new SMSProviderManager();
const retryEngine = new RetryEngine(providerManager);
const walletService = new WalletService(); // Will be defined in Part 3
const sessionManager = new SessionManager(providerManager, retryEngine, walletService);

export {
    providerManager,
    retryEngine,
    sessionManager,
    SessionManager
};

export default sessionManager;
 
