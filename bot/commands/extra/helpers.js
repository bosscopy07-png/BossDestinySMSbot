// bot/commands/extra/helpers.js — shared helpers for the advanced admin dashboard modules
import logger from '../../../utils/logger.js';
import { BOT_IMAGE_URL } from '../../../utils/botImage.js';

// ─── IMAGE CONFIG ───
export const ADMIN_IMAGE_URL = BOT_IMAGE_URL;

// ─── SAFE EDIT HELPER ───
// Prevents "no text in the message to edit" crashes
export async function safeEditMessage(ctx, text, extra = {}) {
    try {
        if (ctx.callbackQuery?.message?.text !== undefined) {
            return await ctx.editMessageText(text, extra);
        }
        return await ctx.reply(text, extra);
    } catch (err) {
        if (err.message?.includes('there is no text in the message') || 
            err.message?.includes('message to edit') ||
            err.message?.includes('MESSAGE_NOT_MODIFIED')) {
            return await ctx.reply(text, extra);
        }
        logger.error('safeEditMessage failed', { error: err.message });
        return await ctx.reply(text, extra);
    }
}

// ─── SAFE EDIT WITH IMAGE HELPER ───
// Sends image with caption instead of plain text for all admin messages
export async function safeEditWithImage(ctx, text, extra = {}) {
    const captionExtra = {
        ...extra,
        parse_mode: extra.parse_mode || 'HTML'
    };
    try {
        // Try to edit existing message caption if it has a photo
        if (ctx.callbackQuery?.message?.photo && ctx.callbackQuery?.message?.caption !== undefined) {
            return await ctx.editMessageCaption(text, captionExtra);
        }
        // If existing message has text, try to edit text first
        if (ctx.callbackQuery?.message?.text !== undefined) {
            return await ctx.editMessageText(text, extra);
        }
        // Otherwise send new photo with caption
        return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
    } catch (err) {
        if (err.message?.includes('there is no text in the message') || 
            err.message?.includes('message to edit') ||
            err.message?.includes('MESSAGE_NOT_MODIFIED') ||
            err.message?.includes('there is no caption in the message')) {
            return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
        }
        logger.error('safeEditWithImage failed', { error: err.message });
        return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
    }
}

/**
 * Admin command handlers — Button-Based Dashboard
 * All actions check adminId before executing
 */
