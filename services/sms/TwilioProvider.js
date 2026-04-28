import twilio from 'twilio';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class TwilioProvider {
  constructor() {
      this.name = 'TWILIO';
      this.tier = 'VIP';
      this.client = twilio(config.twilio.sid, config.twilio.authToken);
      this.phoneNumber = config.twilio.phoneNumber;
      this.isActive = true;
      this.stats = {
          totalSent: 0,
          totalSuccess: 0,
          totalFailed: 0,
          avgResponseTime: 0
      };
      this.errorMap = {
          21211: 'Invalid phone number',
          21214: 'Phone number not available',
          21608: 'Message body required',
          21610: 'Message cannot be sent to this number',
          21612: 'From phone number not valid',
          21614: 'To phone number not valid',
          30002: 'Account suspended',
          30003: 'Message delivery failed',
          30004: 'Message blocked',
          30005: 'Unknown destination',
          30006: 'Landline or unreachable',
          30007: 'Carrier violation',
          30008: 'Unknown error',
          21422: 'Phone number already purchased',
          21421: 'Phone number invalid for region'
      };
  }

  maskPhone(phone) {
      if (!phone || phone.length < 4) return phone;
      return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
  }

  async sendSMS(to, message, options = {}) {
      const startTime = Date.now();
      
      try {
          const result = await this.client.messages.create({
              body: message,
              from: this.phoneNumber,
              to,
              ...options
          });

          const duration = Date.now() - startTime;
          this.updateStats(true, duration);

          logger.info('Twilio SMS sent', {
              provider: this.name,
              to: this.maskPhone(to),
              sid: result.sid,
              status: result.status,
              duration
          });

          return {
              success: true,
              messageId: result.sid,
              status: result.status,
              provider: this.name,
              duration
          };

      } catch (error) {
          const duration = Date.now() - startTime;
          this.updateStats(false, duration);
          const errorInfo = this.handleErrors(error);

          logger.error('Twilio SMS failed', {
              provider: this.name,
              to: this.maskPhone(to),
              error: error.message,
              code: error.code,
              recoverable: errorInfo.recoverable
          });

          return {
              success: false,
              error: errorInfo.message,
              code: error.code,
              provider: this.name,
              recoverable: errorInfo.recoverable,
              duration
          };
      }
  }

  async checkStatus(messageId) {
      try {
          const message = await this.client.messages(messageId).fetch();
          return {
              success: true,
              status: message.status,
              errorCode: message.errorCode,
              errorMessage: message.errorMessage,
              dateSent: message.dateSent,
              dateUpdated: message.dateUpdated,
              price: message.price,
              priceUnit: message.priceUnit
          };
      } catch (error) {
          logger.error('Twilio status check failed', {
              messageId,
              error: error.message,
              code: error.code
          });
          return { 
              success: false, 
              error: error.message,
              code: error.code 
          };
      }
  }

  async getNumber(country = 'US') {
      try {
          const availableNumbers = await this.client.availablePhoneNumbers(country)
              .local.list({ 
                  limit: 1,
                  smsEnabled: true,
                  voiceEnabled: false
              });

          if (availableNumbers.length === 0) {
              throw new Error(`No numbers available in ${country}`);
          }

          return {
              phoneNumber: this.phoneNumber,
              provider: this.name,
              country,
              monthlyCost: 15.00,
              availableNumber: availableNumbers[0].phoneNumber
          };

      } catch (error) {
          logger.error('Twilio number acquisition failed', {
              country,
              error: error.message,
              code: error.code
          });
          throw error;
      }
  }

  async buyNumber(country = 'US') {
      try {
          const availableNumbers = await this.client.availablePhoneNumbers(country)
              .local.list({ 
                  limit: 5,
                  smsEnabled: true,
                  voiceEnabled: false
              });

          if (availableNumbers.length === 0) {
              throw new Error(`No numbers available in ${country}`);
          }

          const selected = availableNumbers[0];
          const smsUrl = config.twilio?.webhookUrl || `${config.appUrl}/webhooks/twilio`;

          const purchasedNumber = await this.client.incomingPhoneNumbers.create({
              phoneNumber: selected.phoneNumber,
              friendlyName: `OTP-${country}-${Date.now()}`,
              smsUrl,
              smsMethod: 'POST',
              smsFallbackUrl: `${smsUrl}/fallback`,
              smsFallbackMethod: 'POST',
              statusCallback: `${smsUrl}/status`,
              statusCallbackMethod: 'POST'
          });

          logger.info('Twilio number purchased', {
              phone: this.maskPhone(purchasedNumber.phoneNumber),
              sid: purchasedNumber.sid,
              country,
              monthlyCost: purchasedNumber.monthlyCost || 1.00
          });

          return {
              phoneNumber: purchasedNumber.phoneNumber,
              sid: purchasedNumber.sid,
              friendlyName: purchasedNumber.friendlyName,
              country,
              monthlyCost: purchasedNumber.monthlyCost || 1.00,
              capabilities: purchasedNumber.capabilities,
              dateCreated: purchasedNumber.dateCreated
          };

      } catch (error) {
          const errorInfo = this.handleErrors(error);
          logger.error('Twilio buy number failed', { 
              country, 
              error: errorInfo.message,
              code: error.code,
              recoverable: errorInfo.recoverable
          });
          throw new Error(`Failed to buy number: ${errorInfo.message}`);
      }
  }

  async releaseNumber(sid) {
      try {
          await this.client.incomingPhoneNumbers(sid).remove();
          logger.info('Twilio number released', { sid });
          return { success: true, sid };
      } catch (error) {
          logger.error('Twilio release number failed', { sid, error: error.message });
          return { success: false, error: error.message, code: error.code };
      }
  }

  async listNumbers(country = null) {
      try {
          const filter = country ? { phoneNumber: { startsWith: `+${this.getCountryCode(country)}` } } : {};
          const numbers = await this.client.incomingPhoneNumbers.list(filter);
          
          return numbers.map(num => ({
              phoneNumber: num.phoneNumber,
              sid: num.sid,
              friendlyName: num.friendlyName,
              country: num.phoneNumberCountryCode,
              capabilities: num.capabilities,
              dateCreated: num.dateCreated,
              status: num.status
          }));
      } catch (error) {
          logger.error('Twilio list numbers failed', { country, error: error.message });
          throw error;
      }
  }

  getCountryCode(country) {
      const codes = { US: '1', UK: '44', CA: '1', AU: '61', DE: '49', FR: '33' };
      return codes[country.toUpperCase()] || '1';
  }

  handleErrors(error) {
      const code = error.code;
      const message = this.errorMap[code] || error.message;
      const nonRecoverable = [30002, 21610, 30004, 21422, 21421];
      
      return {
          code,
          message,
          recoverable: !nonRecoverable.includes(code),
          isAuthError: [20003, 20429].includes(code),
          isRateLimit: error.status === 429 || code === 20429
      };
  }

  updateStats(success, duration) {
      this.stats.totalSent++;
      if (success) {
          this.stats.totalSuccess++;
      } else {
          this.stats.totalFailed++;
      }
      this.stats.avgResponseTime = (
          (this.stats.avgResponseTime * (this.stats.totalSent - 1) + duration) 
          / this.stats.totalSent
      );
  }

  getStats() {
      const total = this.stats.totalSent;
      return {
          name: this.name,
          tier: this.tier,
          isActive: this.isActive,
          ...this.stats,
          successRate: total > 0 
              ? Number((this.stats.totalSuccess / total * 100).toFixed(2))
              : 100,
          failureRate: total > 0
              ? Number((this.stats.totalFailed / total * 100).toFixed(2))
              : 0
      };
  }

  resetStats() {
      this.stats = {
          totalSent: 0,
          totalSuccess: 0,
          totalFailed: 0,
          avgResponseTime: 0
      };
      return this.getStats();
  }
}

export default TwilioProvider;
              
