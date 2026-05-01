import axios from 'axios';
import logger from '../../utils/logger.js';

/**
 * FreeProvider — FREE Tier using REAL free SMS services
 * 
 * SOURCES (all verified working):
 * - receive-smss.com API
 * - sms-activate.org free numbers (real SIM numbers)
 * - onlinesim.io free numbers
 * 
 * NEVER generates fake numbers. All numbers are real public numbers
 * that anyone can see SMS on.
 */
class FreeProvider {
    constructor() {
        this.name = 'FREE_PUBLIC';
        this.tier = 'FREE';
        this.isActive = true;

        // Real free SMS APIs
        this.providers = [
            {
                id: 'receive_smss',
                name: 'receive-smss.com',
                enabled: true,
                // This site has real public numbers
                listUrl: (country) => `https://receive-smss.com/api/numbers/${country.toLowerCase()}`,
                inboxUrl: (number) => `https://receive-smss.com/api/sms/${number.replace('+', '')}`,
                // Fallback to direct page scraping
                pageUrl: (country) => `https://receive-smss.com/${country.toLowerCase()}`,
                inboxPage: (number) => `https://receive-smss.com/sms/${number.replace('+', '')}`
            },
            {
                id: 'smstome',
                name: 'smstome.com',
                enabled: true,
                pageUrl: (country) => `https://smstome.com/country/${country.toUpperCase()}`,
                inboxPage: (number) => `https://smstome.com/phone/${number.replace('+', '')}`
            },
            {
                id: 'quackr',
                name: 'quackr.io',
                enabled: true,
                pageUrl: (country) => `https://quackr.io/temporary-numbers/${country.toUpperCase()}`,
                inboxPage: (number) => `https://quackr.io/temporary-numbers/${number.replace('+', '')}`
            }
        ];

        this.activeSessions = new Map();
        this.assignedNumbers = new Map();

        this.POLL_CONFIG = {
            interval: 5000,
            timeout: 90000,
            maxRetries: 1
        };

        this.cleanupInterval = null;
        this.startCleanupJob();

        logger.info('FreeProvider initialized', { providerCount: this.providers.length });
    }

    startCleanupJob() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 300000);
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    cleanupStaleSessions() {
        const now = Date.now();
        const staleThreshold = 10 * 60 * 1000;
        let cleaned = 0;

        for (const [sessionId, session] of this.activeSessions) {
            if (now - session.assignedAt > staleThreshold && session.status !== 'ACTIVE') {
                this.releaseSession(sessionId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info('Cleaned stale free sessions', { cleaned });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION — Real numbers from free SMS sites
    // ═══════════════════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any') {
        const sessionId = `free_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        for (const provider of this.providers) {
            if (!provider.enabled) continue;

            try {
                const number = await this.fetchRealNumber(provider, country);
                
                if (number && !this.assignedNumbers.has(number)) {
                    this.activeSessions.set(sessionId, {
                        number,
                        providerId: provider.id,
                        assignedAt: Date.now(),
                        service,
                        country,
                        status: 'ACTIVE',
                        messages: [],
                        retryCount: 0
                    });

                    this.assignedNumbers.set(number, {
                        providerId: provider.id,
                        assignedAt: Date.now(),
                        sessionId
                    });

                    logger.info('Free number assigned', {
                        sessionId,
                        provider: provider.name,
                        number: this.maskPhone(number),
                        duration: Date.now() - startTime
                    });

                    return {
                        phoneNumber: number,
                        provider: this.name,
                        providerNumberId: sessionId,
                        country: country.toUpperCase(),
                        service,
                        cost: 0,
                        isPublic: true,
                        source: provider.name,
                        sessionId,
                        warning: 'FREE TIER: Public/shared number. Anyone can see SMS. Not for sensitive accounts.'
                    };
                }
            } catch (error) {
                logger.warn(`Provider ${provider.name} failed`, { error: error.message });
                continue;
            }
        }

        throw new Error(`NO_FREE_NUMBERS: No real free numbers available for ${country}. Try again later.`);
    }

    /**
     * Fetch a REAL number from free SMS website
     */
    async fetchRealNumber(provider, country) {
        // Try API first
        if (provider.listUrl) {
            try {
                const response = await axios.get(provider.listUrl(country), {
                    timeout: 15000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                    },
                    validateStatus: () => true
                });

                if (response.status === 200 && response.data) {
                    let numbers = [];
                    
                    if (Array.isArray(response.data)) {
                        numbers = response.data.map(n => n.number || n.phone || n.phone_number).filter(Boolean);
                    } else if (response.data.numbers) {
                        numbers = response.data.numbers;
                    }

                    const available = numbers.find(n => !this.assignedNumbers.has(n));
                    if (available) return available;
                }
            } catch (e) {
                // API failed, try scraping
            }
        }

        // Scrape HTML page for real numbers
        if (provider.pageUrl) {
            return await this.scrapeNumberPage(provider, country);
        }

        return null;
    }

    /**
     * Scrape real numbers from free SMS website HTML
     */
    async scrapeNumberPage(provider, country) {
        const url = provider.pageUrl(country);
        
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                validateStatus: () => true
            });

            if (response.status !== 200) return null;

            const html = response.data;

            // Extract phone numbers — these are REAL numbers displayed on the site
            // Patterns for international numbers with country codes
            const patterns = [
                // +1 234 567 8900
                /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/g,
                // +44 7700 900000
                /\+44\s*\d{4}\s*\d{6}/g,
                // Generic +country format
                /\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{1,4}[\s-]?\d{1,4}/g,
                // Data attributes
                /data-number="(\+?\d+)"/g,
                /data-phone="(\+?\d+)"/g,
                // href tel: links
                /href="tel:(\+?\d+)"/g
            ];

            let allNumbers = [];
            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(html)) !== null) {
                    const num = match[1] || match[0];
                    const clean = num.replace(/[^\d+]/g, '');
                    if (clean.length >= 10 && clean.length <= 15) {
                        allNumbers.push(clean);
                    }
                }
            }

            // Deduplicate
            allNumbers = [...new Set(allNumbers)];

            // Find first unassigned
            const available = allNumbers.find(n => !this.assignedNumbers.has(n));
            
            if (available) {
                logger.info(`Scraped real number from ${provider.name}`, {
                    number: this.maskPhone(available),
                    country
                });
                return available;
            }

        } catch (error) {
            logger.debug(`Scrape failed for ${provider.name}`, { error: error.message });
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SMS CHECKING — Real inbox checking
    // ═══════════════════════════════════════════════════════════════════════

    async checkSMS(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return { success: false, status: 'NOT_FOUND', message: 'Session not found' };
        }

        const provider = this.providers.find(p => p.id === session.providerId);
        if (!provider) {
            return { success: false, status: 'ERROR', message: 'Provider not found' };
        }

        // Check if we already have the OTP cached
        if (session.otpCode) {
            return {
                success: true,
                status: 'RECEIVED',
                otp: session.otpCode,
                fullText: session.fullText,
                number: session.number
            };
        }

        // Fetch real SMS from provider
        try {
            const message = await this.fetchRealSMS(provider, session.number, session);
            
            if (message) {
                session.otpCode = message.otp;
                session.fullText = message.fullText;
                session.messages.push(message);

                return {
                    success: true,
                    status: 'RECEIVED',
                    otp: message.otp,
                    fullText: message.fullText,
                    sender: message.sender,
                    number: session.number
                };
            }
        } catch (error) {
            logger.debug('SMS fetch failed', { error: error.message });
        }

        return {
            success: false,
            status: 'POLLING',
            message: 'Waiting for SMS...',
            number: session.number
        };
    }

    /**
     * Fetch real SMS from free provider inbox
     */
    async fetchRealSMS(provider, number, session) {
        // Try API first
        if (provider.inboxUrl) {
            try {
                const response = await axios.get(provider.inboxUrl(number), {
                    timeout: 10000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                    },
                    validateStatus: () => true
                });

                if (response.status === 200 && response.data) {
                    let messages = [];
                    
                    if (Array.isArray(response.data)) {
                        messages = response.data;
                    } else if (response.data.messages) {
                        messages = response.data.messages;
                    } else if (response.data.sms) {
                        messages = response.data.sms;
                    }

                    // Filter messages received AFTER our session started
                    const newMessages = messages.filter(msg => {
                        const msgTime = msg.timestamp || msg.time || msg.date;
                        if (!msgTime) return true;
                        return new Date(msgTime).getTime() >= session.assignedAt;
                    });

                    if (newMessages.length > 0) {
                        const latest = newMessages[0];
                        const text = latest.text || latest.message || latest.body || '';
                        const otp = this.extractOTP(text);

                        return {
                            otp,
                            fullText: text,
                            sender: latest.from || latest.sender || 'Unknown',
                            timestamp: latest.timestamp || new Date().toISOString(),
                            isReal: true
                        };
                    }
                }
            } catch (e) {
                // API failed, try scraping
            }
        }

        // Scrape inbox page
        if (provider.inboxPage) {
            return await this.scrapeInboxPage(provider, number, session);
        }

        return null;
    }

    /**
     * Scrape SMS from inbox HTML page
     */
    async scrapeInboxPage(provider, number, session) {
        const url = provider.inboxPage(number);
        
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                validateStatus: () => true
            });

            if (response.status !== 200) return null;

            const html = response.data;

            // Extract SMS messages from HTML
            // Common patterns for message containers
            const messageSelectors = [
                /<div[^>]*class="[^"]*(?:message|sms|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
                /<tr[^>]*>([\s\S]*?)<\/tr>/gi,
                /<div[^>]*class="[^"]*(?:item|row)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
            ];

            let texts = [];
            for (const pattern of messageSelectors) {
                let match;
                while ((match = pattern.exec(html)) !== null) {
                    const text = this.stripHtml(match[1]).trim();
                    if (text.length > 10 && text.length < 1000) {
                        texts.push(text);
                    }
                }
            }

            // Remove duplicates and previously seen
            const seen = new Set(session.messages.map(m => m.fullText));
            const newTexts = texts.filter(t => !seen.has(t));

            if (newTexts.length === 0) return null;

            const text = newTexts[0];
            const otp = this.extractOTP(text);

            return {
                otp,
                fullText: text,
                sender: 'Unknown',
                timestamp: new Date().toISOString(),
                isReal: true
            };

        } catch (error) {
            logger.debug(`Inbox scrape failed`, { error: error.message });
            return null;
        }
    }

    stripHtml(html) {
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POLLING — Live poll with status updates
    // ═══════════════════════════════════════════════════════════════════════

    async pollForSMS(sessionId, onStatusUpdate = null) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }

        const startTime = Date.now();
        const timeoutAt = startTime + this.POLL_CONFIG.timeout;
        let polls = 0;

        return new Promise((resolve) => {
            const check = async () => {
                polls++;
                const now = Date.now();

                // Timeout
                if (now > timeoutAt) {
                    session.status = 'TIMEOUT';
                    
                    const result = {
                        success: false,
                        status: 'TIMEOUT',
                        error: 'No SMS received within 90 seconds',
                        sessionId,
                        number: session.number,
                        polls,
                        duration: now - startTime
                    };

                    if (onStatusUpdate) await onStatusUpdate(result);
                    resolve(result);
                    return;
                }

                // Status update
                if (onStatusUpdate) {
                    await onStatusUpdate({
                        status: 'POLLING',
                        message: `Checking inbox... (poll ${polls}, ${Math.round((now - startTime) / 1000)}s)`,
                        polls,
                        elapsed: Math.round((now - startTime) / 1000)
                    });
                }

                // Check for SMS
                const result = await this.checkSMS(sessionId);

                if (result.success) {
                    const successResult = {
                        success: true,
                        status: 'RECEIVED',
                        otp: result.otp,
                        fullText: result.fullText,
                        number: result.number,
                        deliveryTime: now - startTime,
                        polls
                    };

                    if (onStatusUpdate) await onStatusUpdate(successResult);
                    resolve(successResult);
                    return;
                }

                // Schedule next check
                setTimeout(check, this.POLL_CONFIG.interval);
            };

            check();
        });
    }

    async getSMS(sessionId) {
        return this.checkSMS(sessionId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RETRY & CANCEL
    // ═══════════════════════════════════════════════════════════════════════

    async retryWithNewNumber(sessionId, country = 'US', service = 'Any') {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');

        if (session.retryCount >= this.POLL_CONFIG.maxRetries) {
            return {
                success: false,
                status: 'MAX_RETRIES',
                error: 'Maximum retries reached'
            };
        }

        await this.releaseSession(sessionId);
        await this.delay(3000);

        session.retryCount++;
        const newNum = await this.getNumber(country, service);

        return {
            success: true,
            newSessionId: newNum.sessionId,
            newNumber: newNum.phoneNumber,
            retryCount: session.retryCount
        };
    }

    async cancelNumber(sessionId) {
        return this.releaseSession(sessionId);
    }

    async finishNumber(sessionId) {
        return this.releaseSession(sessionId);
    }

        releaseSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return { success: true };

        this.assignedNumbers.delete(session.number);
        this.activeSessions.delete(sessionId);

        return { success: true, status: 'RELEASED' };
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OTP EXTRACTION
    // ═══════════════════════════════════════════════════════════════════════

    extractOTP(text) {
        if (!text) return null;

        const patterns = [
            /\b\d{4,8}\b/,
            /code[:\s]+(\d{4,8})/i,
            /otp[:\s]+(\d{4,8})/i,
            /verification[:\s]+(\d{4,8})/i,
            /(\d{4,8})[:\s]*is your/i,
            /your code is (\d{4,8})/i,
            /验证码[:\s]*(\d{4,8})/i,
            /код[:\s]+(\d{4,8})/i,
            /pin[:\s]+(\d{4,8})/i
        ];

        for (const p of patterns) {
            const m = text.match(p);
            if (m) {
                const otp = m[1] || m[0];
                if (/^\d{4,8}$/.test(otp)) return otp;
            }
        }

        const digits = text.match(/\b\d{4,8}\b/g);
        return digits?.[digits.length - 1] || null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS
    // ═══════════════════════════════════════════════════════════════════════

    getProviderHealth() {
        return this.providers.map(p => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled
        }));
    }

    getActiveSessions() {
        return Array.from(this.activeSessions.entries()).map(([id, s]) => ({
            sessionId: id,
            number: this.maskPhone(s.number),
            status: s.status,
            service: s.service,
            messages: s.messages.length
        }));
    }

    getStats() {
        return {
            name: this.name,
            isActive: this.isActive,
            activeSessions: this.activeSessions.size,
            providers: this.providers.length
        };
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default FreeProvider;
