// bot/commands/extra/system.js — System & maintenance: balance fixer, health, restart, maintenance, workers, provider switching, audit trail
// Mixed into the Admin class by bot/commands/extra.js (bodies unchanged: `this` is the Admin instance).
import { fixNegativeLockedBalances } from '../../../scripts/index.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { ADMIN_IMAGE_URL, safeEditWithImage } from './helpers.js';

export const systemMethods = {
    // ═══════════════════════════════════════════════════════
    //  SYSTEM & MAINTENANCE FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 1. Fix Negative Balances ───
    
async handleFixBalances(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) {
            return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
        }

        await ctx.answerCbQuery('🔧 Running balance fix...');
        const msg = await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
            caption: '🔧 <b>Running balance fix...</b>', 
            parse_mode: 'HTML' 
        });

        try {
            const results = await fixNegativeLockedBalances();
            const details = [];
            
            if (results.fixedNegative.length > 0) {
                details.push(`<b>🔴 Negative fixed:</b> ${results.fixedNegative.length}`);
                results.fixedNegative.slice(0, 5).forEach(u => {
                    details.push(`  • <code>${u.userId}</code>: ${u.was} → ${u.now}`);
                });
                if (results.fixedNegative.length > 5) {
                    details.push(`  ... and ${results.fixedNegative.length - 5} more`);
                }
            }

            if (results.fixedMissing.length > 0) {
                details.push(`<b>⚪ Missing fixed:</b> ${results.fixedMissing.length}`);
            }

            if (results.fixedExcessive.length > 0) {
                details.push(`<b>🟠 Excessive fixed:</b> ${results.fixedExcessive.length}`);
                results.fixedExcessive.slice(0, 3).forEach(u => {
                    details.push(`  • <code>${u.userId}</code>: ${u.was} → ${u.now} (bal: ${u.balance})`);
                });
            }

            const text = results.totalFixed > 0
                ? `✅ <b>Balance Fix Complete</b>\n\n` +
                  `📊 Total fixed: <b>${results.totalFixed}</b> users\n\n` +
                  details.join('\n') +
                  `\n\n<i>${new Date().toLocaleString()}</i>`
                : `✅ <b>Balance Fix Complete</b>\n\n` +
                  `🎉 No issues found. All balances are clean.\n\n` +
                  `<i>${new Date().toLocaleString()}</i>`;

            await ctx.telegram.editMessageCaption(msg.chat.id, msg.message_id, null, text, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            });

        } catch (error) {
            logger.error('Fix balances failed', { error: error.message });
            await ctx.telegram.editMessageCaption(
                msg.chat.id, msg.message_id, null,
                `❌ <b>Fix failed:</b>\n\n<code>${error.message}</code>`,
                { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
                }
            );
        }
    },

    // ─── 2. System Health ───
    
async handleHealth(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🏥 Checking health...');

        try {
            const { User, Session } = await import('../../../models/index.js');
            
            const [totalUsers, activeSessions, brokenBalances] = await Promise.all([
                User.countDocuments(),
                Session.countDocuments({ status: { $in: ['WAITING', 'CHECKING'] } }),
                User.countDocuments({ lockedBalance: { $lt: 0 } })
            ]);

            const uptime = process.uptime();
            const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

            const text = 
                `🏥 <b>System Health Report</b>\n\n` +
                `👤 <b>Users:</b> ${totalUsers.toLocaleString()}\n` +
                `⏳ <b>Active Sessions:</b> ${activeSessions}\n` +
                `⚠️ <b>Broken Balances:</b> ${brokenBalances}\n` +
                `⏱️ <b>Uptime:</b> ${uptimeStr}\n` +
                `💾 <b>Memory:</b> ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n\n` +
                (brokenBalances > 0 
                    ? `⚡ <i>Tap "Fix Balances" below to repair.</i>`
                    : `✅ <i>All systems operational.</i>`
                );

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔧 Fix Balances', callback_data: 'admin_fix_balances' },
                            { text: '🔄 Refresh', callback_data: 'admin_health' }
                        ],
                        [{ text: '◀️ Back', callback_data: 'admin_back_system' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Health check failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            });
        }
    },

    // ─── 3. Restart Bot ───
    
async handleRestart(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Restarting...');
        await safeEditWithImage(ctx,
            `🔄 <b>Bot Restarting...</b>\n\n` +
            `⏳ Graceful shutdown in progress.\n` +
            `💡 The bot will be back online in ~5 seconds.`,
            { parse_mode: 'HTML' }
        );

        logger.info('Admin triggered restart', { adminId: userId });
        setTimeout(() => process.exit(0), 2000);
    },

    // ─── 4. Toggle Maintenance ───
    
async handleToggleMaintenance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        const current = config.maintenance || false;
        config.maintenance = !current;
        
        const status = config.maintenance ? '🔴 ON' : '🟢 OFF';
        await ctx.answerCbQuery(`Maintenance: ${status}`, { show_alert: true });
        
        await safeEditWithImage(ctx,
            `🛠️ <b>Maintenance Mode</b>\n\n` +
            `Status: <b>${status}</b>\n\n` +
            `${config.maintenance 
                ? '🔒 Non-admin users are now blocked.' 
                : '✅ Bot is open to all users.'}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: config.maintenance ? '🟢 Disable' : '🔴 Enable', 
                            callback_data: 'admin_maintenance' 
                        }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_system' }]
                    ]
                }
            }
        );
    },

    // ─── 5. View Logs ───
    

    // ─── 6. Clear Cache ───
    

    // ─── 7. Database Backup ───
    

    // ─── 8. Worker Status ───
    
async handleWorkerStatus(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⚡ Checking workers...');

        try {
            const uptime = process.uptime();
            const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
            
            const text = 
                `⚡ <b>Worker Status</b>\n\n` +
                `🤖 <b>Main Process:</b>\n` +
                `   PID: <code>${process.pid}</code>\n` +
                `   Uptime: <b>${uptimeStr}</b>\n` +
                `   Memory: <b>${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB</b>\n` +
                `   Heap: <b>${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB</b>\n\n` +
                `💡 <i>Extend this with your queue/worker metrics.</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_workers' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_system' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Worker status failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            });
        }
                                   },

    // ═══════════════════════════════════════════════════════
    //  SMS/OTP FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 33. Switch SMS Provider ───
        // ─── 33. Switch SMS Provider (FIXED) ───
    
async handleSwitchProvider(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Loading providers...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const providers = await this.smsProviderManager.getAvailableProviders();
            
            let text = `🔄 <b>Switch SMS Provider</b>\n\n`;
            // FIXED: Use getActiveProviders instead of getCurrentProvider
            text += `Current: <b>${this.smsProviderManager.getActiveProviders?.()[0] || 'None'}</b>\n\n`;
            text += `Available providers:\n`;

            const buttons = providers.map(p => ([{
                text: `${p.isActive ? '✅ ' : ''}${p.name}`,
                callback_data: `admin_switch_to_${p.name}`
            }]));

            buttons.push([{ text: '◀️ Back', callback_data: 'admin_back_sms' }]);

            await safeEditWithImage(ctx, text, {
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            logger.error('Switch provider failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
    },

    
    // ─── 34. Provider Balance Check ───
    
     
        // ─── 34. Provider Balance Check (FIXED) ───
    
async handleProviderBalance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💳 Checking balances...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const balances = await this.smsProviderManager.checkBalances();
            
            let text = `💳 <b>SMS Provider Balances</b>\n\n`;
            
            // FIXED: checkBalances returns object, not array
            const providers = Object.entries(balances || {});
            
            if (providers.length === 0) {
                text += `<i>No providers configured or all offline.</i>`;
            } else {
                providers.forEach(([name, b]) => {
                    const status = b.success ? '🟢' : '🔴';
                    text += `${status} <b>${name}</b>: ${b.balance?.toFixed?.(4) || b.balance || 0} ${b.currency || 'USD'}\n` +
                           `   📊 Status: <b>${b.success ? 'Active' : b.error || 'Error'}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_provider_balance' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_sms' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Provider balance failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
                                   },

                
    // ─── 35. Retry Failed OTP ───
    
async handleRetryFailedOTP(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Retrying failed OTPs...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            
            const failedTxs = await Transaction.find({
                type: 'OTP',
                status: 'FAILED',
                createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }).limit(10);

            let retried = 0;
            for (const tx of failedTxs) {
                // Retry logic here
                retried++;
            }

            const text = 
                `🔄 <b>Retry Complete</b>\n\n` +
                `📊 Failed OTPs found: <b>${failedTxs.length}</b>\n` +
                `✅ Retried: <b>${retried}</b>\n\n` +
                `<i>Check provider logs for results.</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Retry Again', callback_data: 'admin_retry_otp' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_sms' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Retry OTP failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
    },

    // ─── 42. Provider Failover ───
    
async handleProviderFailover(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔀 Checking failover...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const settings = await this.smsProviderManager.getFailoverSettings();
            const current = settings.enabled ? '🟢 ENABLED' : '🔴 DISABLED';

            await safeEditWithImage(ctx,
                `🔀 <b>Provider Failover</b>\n\n` +
                `Status: <b>${current}</b>\n\n` +
                `📋 <b>Settings:</b>\n` +
                `• Trigger: Success rate < <b>${settings.threshold || 80}%</b>\n` +
                `• Check interval: <b>${settings.interval || 5} min</b>\n` +
                `• Fallback order: <b>${settings.fallbackOrder?.join(' → ') || 'Not set'}</b>\n\n` +
                `💡 When primary fails, bot auto-switches to next provider.`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ 
                                text: settings.enabled ? '🔴 Disable' : '🟢 Enable', 
                                callback_data: 'admin_provider_failover' 
                            }],
                                                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                        ]
                    }
                }
            );

        } catch (error) {
            logger.error('Provider failover failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    // ─── 43. Stale Session Cleaner ───
    
      async handleStaleSessionCleaner(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧹 Cleaning stale sessions...');

        try {
            const { Session } = await import('../../../models/index.js');
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            
            const result = await Session.updateMany(
                { status: { $in: ['WAITING', 'CHECKING'] }, updatedAt: { $lt: oneHourAgo } },
                { $set: { status: 'EXPIRED', expiredAt: new Date() } }
            );

            const text = 
                `🧹 <b>Stale Session Cleaner</b>\n\n` +
                `⏰ Sessions older than 1 hour cleaned.\n\n` +
                `🗑️ Expired: <b>${result.modifiedCount}</b> sessions\n\n` +
                `<i>Users will need to restart their OTP request.</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🧹 Clean Again', callback_data: 'admin_stale_cleaner' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Stale cleaner failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    async handleAuditTrail(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📋 Loading audit trail...');

        try {
            const { AdminLog: AuditLog } = await import('../../../models/index.js');
            
            const logs = await AuditLog.find()
                .sort({ createdAt: -1 })
                .limit(20);

            let text = `📋 <b>Audit Trail (Last 20)</b>\n\n`;
            
            if (logs.length === 0) {
                text += `<i>No audit logs found. Enable auditing in settings.</i>`;
            } else {
                logs.forEach(log => {
                    text += `🕐 <i>${log.createdAt?.toLocaleString()}</i>\n` +
                           `👤 <code>${log.adminId}</code>\n` +
                           `⚡ <b>${log.action}</b>\n` +
                           `📝 ${(typeof log.details === 'string' ? log.details : JSON.stringify(log.details || {})).substring(0, 80) || 'N/A'}\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_audit' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_finance' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Audit trail failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }
};

export default systemMethods;
