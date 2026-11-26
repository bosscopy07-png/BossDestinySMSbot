// bot/middleware/autoEdit.js — "one screen" UX.
// Every ctx.reply / ctx.replyWithPhoto made while handling a button tap EDITS the tapped message instead of
// sending a new one. Replies to typed input edit the current screen and tidy away the user's text message.
// Existing handlers need NO changes: they keep calling ctx.reply / ctx.replyWithPhoto.
import { anchor, notModified } from '../ui/anchor.js';
import logger from '../../utils/logger.js';

const DEFAULT_KB = { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]] };

export function autoEdit() {
    return async (ctx, next) => {
        if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.telegram) return next();
        const chatId = ctx.chat.id;
        const cbMsg = ctx.callbackQuery?.message || null;
        let consumed = false;
        let deferredDelete = false;

        if (cbMsg) anchor.set(chatId, cbMsg.message_id, !!cbMsg.photo);

        const target = () => {
            if (cbMsg) return { messageId: cbMsg.message_id, photo: !!cbMsg.photo };
            const a = anchor.get(chatId);
            return a ? { messageId: a.messageId, photo: a.photo } : null;
        };
        const removeOld = (t, newId) => { if (t && t.messageId !== newId) ctx.telegram.deleteMessage(chatId, t.messageId).catch(() => {}); };

        const origReply = ctx.reply.bind(ctx);
        const origPhoto = ctx.replyWithPhoto.bind(ctx);
        const origDelete = ctx.deleteMessage.bind(ctx);
        const origEditText = ctx.editMessageText?.bind(ctx);
        const origEditCaption = ctx.editMessageCaption?.bind(ctx);

        ctx.reply = async (text, extra = {}) => {
            const t = target();
            if (t && !extra.reply_to_message_id && typeof text === 'string') {
                const opts = { parse_mode: extra.parse_mode, disable_web_page_preview: true,
                    reply_markup: extra.reply_markup || (cbMsg ? DEFAULT_KB : undefined) };
                try {
                    if (t.photo) {
                        if (text.length > 1024) throw new Error('caption too long');
                        await ctx.telegram.editMessageCaption(chatId, t.messageId, undefined, text, opts);
                    } else {
                        await ctx.telegram.editMessageText(chatId, t.messageId, undefined, text, opts);
                    }
                    anchor.set(chatId, t.messageId, t.photo); consumed = true;
                    return { message_id: t.messageId, chat: { id: chatId } };
                } catch (e) {
                    if (notModified(e)) { consumed = true; return { message_id: t.messageId, chat: { id: chatId } }; }
                    logger.debug?.('autoEdit: edit failed, sending new', { error: e.message });
                }
            }
            const sent = await origReply(text, extra);
            if (cbMsg) removeOld(t, sent.message_id); else if (t) removeOld(t, sent.message_id);
            anchor.set(chatId, sent.message_id, false); consumed = true;
            return sent;
        };

        ctx.replyWithPhoto = async (photo, extra = {}) => {
            const t = target();
            if (t && t.photo && typeof photo === 'string' && !extra.reply_to_message_id) {
                try {
                    await ctx.telegram.editMessageMedia(chatId, t.messageId, undefined,
                        { type: 'photo', media: photo, caption: extra.caption, parse_mode: extra.parse_mode },
                        { reply_markup: extra.reply_markup || (cbMsg ? DEFAULT_KB : undefined) });
                    anchor.set(chatId, t.messageId, true); consumed = true;
                    return { message_id: t.messageId, chat: { id: chatId } };
                } catch (e) {
                    if (notModified(e)) { consumed = true; return { message_id: t.messageId, chat: { id: chatId } }; }
                    logger.debug?.('autoEdit: media edit failed, sending new', { error: e.message });
                }
            }
            const sent = await origPhoto(photo, extra);
            removeOld(t, sent.message_id);
            anchor.set(chatId, sent.message_id, true); consumed = true;
            return sent;
        };

        // handlers often do `await ctx.deleteMessage(); await ctx.reply(...)`: defer the delete so the reply can edit in place
        ctx.deleteMessage = async (id) => {
            if (id === undefined && cbMsg) { deferredDelete = true; return true; }
            return origDelete(id);
        };
        if (origEditText) ctx.editMessageText = async (...a) => { const r = await origEditText(...a); consumed = true; return r; };
        if (origEditCaption) ctx.editMessageCaption = async (...a) => { const r = await origEditCaption(...a); consumed = true; return r; };

        try { await next(); }
        finally {
            try {
                if (deferredDelete && !consumed && cbMsg) { await origDelete(); anchor.clear(chatId); }
                // keep the chat clean: remove the user's typed text / command once the bot has answered it
                if (!cbMsg && consumed && ctx.message?.text) ctx.telegram.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
            } catch (_) { /* best effort */ }
        }
    };
}
export default autoEdit;
