'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_REFRESH_AFTER_MS = 5 * 60 * 1000;

function scrypt(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

let dummyHash;

/** اگر stored تهی باشد (کاربر ناموجود)، برای یکسان‌سازی زمان، با یک هش ساختگی مقایسه می‌کند و false می‌دهد */
async function verifyPassword(password, stored) {
  const real = Boolean(stored);
  if (!real) dummyHash ??= await hashPassword('dummy-password-for-timing');
  const [alg, saltB64, hashB64] = (real ? stored : dummyHash).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected) && real;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    Date.now() + SESSION_TTL_MS,
  );
  return token;
}

function findSession(db, token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, Date.now());
  if (!row) return null;
  if (row.expires_at - Date.now() < SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      Date.now() + SESSION_TTL_MS,
      tokenHash,
    );
  }
  return { id: row.id, username: row.username, role: row.role, tokenHash };
}

function destroySession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function purgeExpired(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(length = 14) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'رمز عبور باید حداقل ۸ نویسه باشد');
  }
  if (password.length > 200) throw new HttpError(400, 'رمز عبور بیش از حد طولانی است');
}

async function createUser(db, username, role, password) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw new HttpError(400, 'نام کاربری باید ۳ تا ۳۲ نویسه لاتین/عدد/نقطه/خط‌تیره باشد');
  }
  if (role !== 'operator' && role !== 'viewer') throw new HttpError(400, 'نقش نامعتبر است');
  validatePassword(password);
  const hash = await hashPassword(password);
  try {
    db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
      name,
      hash,
      role,
      Date.now(),
    );
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'این نام کاربری قبلاً وجود دارد');
    throw err;
  }
  return name;
}

async function setPassword(db, userId, password) {
  validatePassword(password);
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

/** محدودکننده ساده تلاش‌های ناموفق ورود به‌ازای هر IP */
function createLimiter({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
  const map = new Map();
  return {
    blocked(key) {
      const e = map.get(key);
      if (!e) return false;
      if (Date.now() - e.first > windowMs) {
        map.delete(key);
        return false;
      }
      return e.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const e = map.get(key);
      if (!e || now - e.first > windowMs) map.set(key, { count: 1, first: now });
      else e.count++;
    },
    reset(key) {
      map.delete(key);
    },
  };
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  createSession,
  findSession,
  destroySession,
  purgeExpired,
  parseCookies,
  generatePassword,
  validatePassword,
  createUser,
  setPassword,
  createLimiter,
};
