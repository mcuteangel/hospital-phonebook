'use strict';

/**
 * رمزنگاری ستون‌های حساس (موبایل، تلفن منزل، ایمیل، آدرس، کد ملی).
 *
 * مدل: یک کلید داده (DEK) که فقط از رمز عبور کاربر admin ساخته می‌شود
 * (scrypt با نمکی که در جدول meta ذخیره شده)؛ خود DEK هرگز ذخیره
 * نمی‌شود و فقط در حافظه سرور زنده است. بعد از هر راه‌اندازی مجدد،
 * سرور «قفل» است تا وقتی admin وارد شود (ورود admin کلید را می‌سازد
 * و داده‌های قدیمی رمزنشده را هم همان‌جا رمز می‌کند).
 *
 * پیامد صادقانه: اگر رمز admin گم شود، داده‌های حساس قابل بازیابی
 * نیستند (همان‌قدر که گم‌شدن رمز هر سیستم رمزنگاری). پشتیبان CSV را
 * فقط وقتی قفل باز است می‌شود گرفت و همان هم باید جای امنی نگه داشته
 * شود. تغییر رمز admin از طریق API یا manage.js، همه ستون‌ها را با
 * کلید جدید بازرمز می‌کند؛ برای همین set-password برای admin به رمز
 * فعلی نیاز دارد.
 */
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const PREFIX = 'enc1:';
const SENSITIVE_COLS = ['mobile', 'home_phone', 'email', 'address', 'national_id'];
const LOCKED_MESSAGE = 'داده‌های حساس قفل است؛ admin باید وارد شود';

let dek = null;

function setDek(value) {
  dek = value;
}
function getDek() {
  return dek;
}
function clearDek() {
  dek = null;
}
function requireDek() {
  if (!dek) throw new HttpError(401, LOCKED_MESSAGE, 'locked');
  return dek;
}

function deriveDek(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function getOrCreateSalt(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'encryption_salt'").get();
  if (row) return Buffer.from(row.value, 'base64');
  const salt = crypto.randomBytes(16);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('encryption_salt', salt.toString('base64'));
  return salt;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** رشته خالی همان خالی می‌ماند تا فیلتر «دارد/ندارد» در SQL درست بماند */
function encryptValue(key, plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${Buffer.concat([body, tag]).toString('base64')}`;
}

function decryptValue(key, value) {
  if (!value || !isEncrypted(value)) return value;
  const rest = value.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  const iv = Buffer.from(rest.slice(0, sep), 'base64');
  const data = Buffer.from(rest.slice(sep + 1), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  const body = decipher.update(data.subarray(0, data.length - 16));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([body, decipher.final()]).toString('utf8');
}

/** رمز کردن فیلدهای حساس یک رکوردِ parseشده (برای INSERT/UPDATE) */
function encryptPersonFields(key, p) {
  const out = { ...p };
  for (const col of SENSITIVE_COLS) out[col] = encryptValue(key, p[col]);
  return out;
}

/** رمزگشایی فیلدهای حساس یک ردیف دیتابیس (در حافظه، بدون تغییر DB) */
function decryptRow(key, row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of SENSITIVE_COLS) {
    if (out[col]) out[col] = decryptValue(key, out[col]);
  }
  return out;
}

/** رمز کردن مقادیر قدیمیِ رمزنشده؛ در هر ورود admin اجرا می‌شود (idempotent) */
function migratePlaintext(db, key) {
  const rows = db.prepare(`SELECT id, ${SENSITIVE_COLS.join(', ')} FROM persons`).all();
  const update = db.prepare(
    `UPDATE persons SET ${SENSITIVE_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  let changed = 0;
  for (const r of rows) {
    let dirty = false;
    const vals = {};
    for (const col of SENSITIVE_COLS) {
      vals[col] = r[col];
      if (r[col] && !isEncrypted(r[col])) {
        vals[col] = encryptValue(key, r[col]);
        dirty = true;
      }
    }
    if (dirty) {
      update.run(...SENSITIVE_COLS.map((c) => vals[c]), r.id);
      changed++;
    }
  }
  return changed;
}

/** بازرمز همه ستون‌ها با کلید جدید (تغییر رمز admin)؛ مقادیر رمزنشده هم مستقیم با کلید جدید رمز می‌شوند */
function reencryptAll(db, oldKey, newKey) {
  const rows = db.prepare(`SELECT id, ${SENSITIVE_COLS.join(', ')} FROM persons`).all();
  const update = db.prepare(
    `UPDATE persons SET ${SENSITIVE_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  for (const r of rows) {
    const vals = {};
    for (const col of SENSITIVE_COLS) {
      if (!r[col]) vals[col] = '';
      else if (isEncrypted(r[col])) vals[col] = encryptValue(newKey, decryptValue(oldKey, r[col]));
      else vals[col] = encryptValue(newKey, r[col]);
    }
    update.run(...SENSITIVE_COLS.map((c) => vals[c]), r.id);
  }
}

module.exports = {
  PREFIX,
  SENSITIVE_COLS,
  LOCKED_MESSAGE,
  setDek,
  getDek,
  clearDek,
  requireDek,
  deriveDek,
  getOrCreateSalt,
  isEncrypted,
  encryptValue,
  decryptValue,
  encryptPersonFields,
  decryptRow,
  migratePlaintext,
  reencryptAll,
};
