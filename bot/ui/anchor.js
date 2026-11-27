// bot/ui/anchor.js — tracks the ONE message per private chat that the bot keeps editing ("the screen").
// Used by the auto-edit middleware and by background services (OTP delivery, expiry) so they update the
// screen in place instead of sending new messages. In-memory: after a restart the next screen is a fresh message.
const anchors = new Map(); // chatId -> { messageId, photo, at }
const MAX_AGE = 47 * 3600 * 1000;

export const anchor = {
    get(chatId) { const a = anchors.get(String(chatId)); return a && Date.now() - a.at < MAX_AGE ? a : null; },
    set(chatId, messageId, photo) { anchors.set(String(chatId), { messageId, photo: !!photo, at: Date.now() }); },
    clear(chatId) { anchors.delete(String(chatId)); },
    size: () => anchors.size
};

const stripHtml = (t) => String(t).replace(/<[^>]+>/g, '');
const notModified = (e) => /not modified/i.test(e?.description || e?.message || '');

/**
 * Update the user's screen in place (or send it if there is none). Never throws.
 * `photo` is only used when a brand-new message has to be sent as a photo.
 */
export async function editOrSend(telegram, chatId, { text, reply_markup, parse_mode = 'HTML', photo = null }) {
    const a = anchor.get(chatId);
    const opts = { parse_mode, reply_markup, disable_web_page_preview: true };
    if (a) {
        try {
            if (a.photo) {
                if (text.length > 1024) throw new Error('caption too long');
                await telegram.editMessageCaption(chatId, a.messageId, undefined, text, opts);
            } else {
                await telegram.editMessageText(chatId, a.messageId, undefined, text, opts);
            }
            anchor.set(chatId, a.messageId, a.photo);
            return { message_id: a.messageId, edited: true };
        } catch (e) {
            if (notModified(e)) return { message_id: a.messageId, edited: true };
            // fall through: send a fresh screen and remove the stale one
        }
    }
    try {
        const sent = photo && text.length <= 1024
            ? await telegram.sendPhoto(chatId, photo, { caption: text, ...opts })
            : await telegram.sendMessage(chatId, text, opts);
        if (a) telegram.deleteMessage(chatId, a.messageId).catch(() => {});
        anchor.set(chatId, sent.message_id, !!(photo && text.length <= 1024));
        return { message_id: sent.message_id, edited: false };
    } catch (e) { return { error: e.message }; }
}

/** Optional audible nudge: a tiny message that deletes itself (edits don't make a notification sound). */
export async function ping(telegram, chatId, text = '🔔 Code received') {
    if (process.env.OTP_PING !== 'true') return;
    try { const m = await telegram.sendMessage(chatId, text, { disable_notification: false }); setTimeout(() => telegram.deleteMessage(chatId, m.message_id).catch(() => {}), 6000); } catch (_) {}
}
export { stripHtml, notModified };
    
