// utils/botImage.js — the ONE image used by every screen of the bot.
// Set BOT_IMAGE_URL in your environment (.env). If it is not set, the previous default image is used.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../.env') });

const DEFAULT_IMAGE = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';
export const BOT_IMAGE_URL = (process.env.BOT_IMAGE_URL || '').trim() || DEFAULT_IMAGE;
export default BOT_IMAGE_URL;
