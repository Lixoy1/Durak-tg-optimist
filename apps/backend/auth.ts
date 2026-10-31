import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: string;
  username: string;
  firstName: string;
}

export interface TelegramAuthOptions {
  nowSeconds?: number;
  maxAgeSeconds?: number;
  futureSkewSeconds?: number;
}

export class AuthError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AuthError';
  }
}

/** Validates Telegram Mini App initData server-side. Never trust initDataUnsafe from the browser. */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: TelegramAuthOptions = {},
): TelegramUser {
  if (!botToken || !botToken.includes(':')) throw new AuthError('SERVER_CONFIG', 'Telegram bot token is not configured.');
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 16_384) {
    throw new AuthError('INVALID_INIT_DATA', 'Missing or oversized Telegram initData.');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new AuthError('INVALID_HASH', 'Missing or malformed Telegram signature.');
  }
  if (params.getAll('hash').length !== 1) throw new AuthError('INVALID_HASH', 'Duplicate signature parameter.');

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const supplied = Buffer.from(receivedHash, 'hex');
  if (supplied.length !== calculatedHash.length || !timingSafeEqual(supplied, calculatedHash)) {
    throw new AuthError('INVALID_SIGNATURE', 'Telegram signature verification failed.');
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 86_400;
  const futureSkew = options.futureSkewSeconds ?? 30;
  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) throw new AuthError('INVALID_AUTH_DATE', 'Missing or invalid auth_date.');
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate > now + futureSkew || now - authDate > maxAge) {
    throw new AuthError('EXPIRED_INIT_DATA', 'Telegram session has expired. Reopen the Mini App.');
  }

  const userRaw = params.get('user');
  if (!userRaw || userRaw.length > 4_096) throw new AuthError('MISSING_USER', 'Telegram user data is missing.');
  let parsed: unknown;
  try { parsed = JSON.parse(userRaw); } catch { throw new AuthError('INVALID_USER', 'Telegram user data is malformed.'); }
  if (!parsed || typeof parsed !== 'object') throw new AuthError('INVALID_USER', 'Telegram user data is malformed.');
  const user = parsed as Record<string, unknown>;
  const id = user.id;
  if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^\d+$/.test(id))) {
    throw new AuthError('INVALID_USER_ID', 'Telegram user ID is invalid.');
  }
  const firstName = typeof user.first_name === 'string' ? user.first_name.trim().slice(0, 64) : '';
  const username = typeof user.username === 'string' ? user.username.trim().slice(0, 64) : firstName;
  return { id: String(id), username: username || `Player_${id}`, firstName: firstName || 'Игрок' };
}
