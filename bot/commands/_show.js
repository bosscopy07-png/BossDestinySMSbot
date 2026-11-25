// bot/commands/_show.js — render a screen by editing the current message (text or photo caption) or sending a new one.
import logger from '../../utils/logger.js';

export async function show(ctx, { text, reply_markup }) {
    const opts = { parse_mode: 'HTML', reply_markup, disable_web_page_preview: true };
    if (ctx.callbackQuery) {
        try { await ctx.editMessageText(text, opts); return; } catch (e) {
            if (/not modified/i.test(e.message || '')) return;
            try { await ctx.editMessageCaption(text, opts); return; } catch (e2) {
                if (/not modified/i.test(e2.message || '')) return;
            }
        }
    }
    try { await ctx.reply(text, opts); } catch (e) { logger.error('show() failed', { error: e.message }); }
}
export const safeAnswer = (ctx, t) => ctx.answerCbQuery(t).catch(() => {});
      
