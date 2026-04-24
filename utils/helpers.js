import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const generateId = () => {
    return crypto.randomBytes(16).toString('hex');
};

export const generateReferralCode = (userId) => {
    const hash = crypto.createHash('sha256')
        .update(String(userId) + process.env.JWT_SECRET)
        .digest('hex');
    return hash.substring(0, 8).toUpperCase();
};

export const maskOTP = (otp) => {
    if (!otp || otp.length <= 3) return '***';
    return '*'.repeat(otp.length - 3) + otp.slice(-3);
};

export const formatCurrency = (amount) => {
    return `$${Number(amount).toFixed(2)}`;
};

export const isNewDay = (lastDate) => {
    if (!lastDate) return true;
    const last = new Date(lastDate);
    const now = new Date();
    return last.getDate() !== now.getDate() ||
           last.getMonth() !== now.getMonth() ||
           last.getFullYear() !== now.getFullYear();
};

export const getDuration = (startTime) => {
    return Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
};

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const escapeMarkdown = (text) => {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

export const validateAddress = (address) => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

export const derivePath = (index) => {
    return `m/44'/60'/0'/0/${index}`;
};
