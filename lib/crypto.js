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
 *
 * همگام‌سازی کلید با چرخش CLI: اثر انگشت DEK (SHA-256 آن) در جدول
 * meta ذخیره می‌شود. هر بار که کلید نصب می‌شود (ورود admin، تغییر رمز
 * از API، یا چرخش CLI) اثر انگشت هم به‌روز می‌شود؛ اگر سروری در حال
 * اجرا ببیند اثر انگشت ذخیره‌شده با کلید حافظه‌اش نمی‌خواند (یعنی CLI
 * در این فاصله کلید را عوض کرده)، خودش را قفل می‌کند تا ورود بعدی
 * admin با رمز جدید قفل را باز کند. این جلوی نوشتن با کلید قدیمی و
 * ساخته‌شدن داده دورگه (بخشی با کلید قدیم، بخشی با کلید جدید) را
 * می‌گیرد. اگر اثری ثبت نشده باشد (مثلاً دیتابیس قدیمی)، بررسی
 * بی‌اثر است تا رفتار قبلی نشکند.
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

function dekFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function readDekFingerprint(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'dek_fingerprint'").get();
  return row ? row.value : null;
}

let fingerprintExpected = false;

function writeDekFingerprint(db, key) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('dek_fingerprint', dekFingerprint(key));
  fingerprintExpected = true;
}

/**
 * آیا این پروسه سرور تا حالا اثری ثبت کرده است؟ اگر بله و اثر در
 * دیتابیس نیست (مثلاً meta دست‌کاری یا با نسخه قدیمی جایگزین شده)،
 * نبودِ اثر هم باید قفل کند، نه اینکه بررسی بی‌اثر شود و کلید قدیمی
 * به کار ادامه دهد. پروسه CLI حافظه جداگانه دارد و روی این پرچم
 * سرور اثری نمی‌گذارد.
 */
function isFingerprintExpected() {
  return fingerprintExpected;
}

/**
 * فقط یک پاکت رمز کامل، معتبر است: `enc1:<iv-base64>:<body+tag-base64>`
 * با IV دقیقاً ۱۲ بایتی و دست‌کم ۱ بایت متن + ۱۶ بایت تگ. بررسیِ صرفِ
 * پیشوند کافی نیست: یک مقدار قدیمیِ رمزنشده مثل `enc1: reception`
 * (آدرس آزاد) با بررسی پیشوندی «رمز شده» شمرده می‌شد، مهاجرت از آن
 * رد می‌شد و بعد رمزگشایی‌اش به‌عنوان GCM خطا می‌داد و خواندن اپراتور
 * را خراب می‌کرد. چنین مقادیری حالا رمزنشده شمرده و رمز می‌شوند.
 */
function isEncrypted(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return false;
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 2) return false;
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(parts[0]) || !b64.test(parts[1])) return false;
  const iv = Buffer.from(parts[0], 'base64');
  const data = Buffer.from(parts[1], 'base64');
  return iv.length === 12 && data.length > 16;
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
  const body = decipher.update(data.subarray(0, -16));
  decipher.setAuthTag(data.subarray(-16));
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

/** رمز کردن ستون‌های حساس یک ردیف قدیمی؛ برمی‌گرداند که آیا چیزی عوض شد */
function migrateRowValues(key, r) {
  let dirty = false;
  const vals = {};
  for (const col of SENSITIVE_COLS) {
    vals[col] = r[col];
    if (r[col] && !isEncrypted(r[col])) {
      vals[col] = encryptValue(key, r[col]);
      dirty = true;
    }
  }
  return { vals, dirty };
}

/**
 * رمز کردن مقادیر قدیمیِ رمزنشده؛ در هر ورود admin اجرا می‌شود (idempotent).
 * ردیف‌ها دسته‌ای (۵۰۰تایی، بر اساس id) خوانده می‌شوند تا حافظه با
 * بزرگ‌شدن دفترچه (سقف ورود CSV هم ۲۰٬۰۰۰ ردیف است) بی‌رویه بالا نرود.
 * فراخواننده تراکنش را نگه می‌دارد، پس دسته‌بندی اتمی‌بودن را نمی‌شکند.
 */
function migratePlaintext(db, key) {
  const select = db.prepare(`SELECT id, ${SENSITIVE_COLS.join(', ')} FROM persons WHERE id > ? ORDER BY id LIMIT 500`);
  const update = db.prepare('UPDATE persons SET ' + SENSITIVE_COLS.map((c) => c + ' = ?').join(', ') + ' WHERE id = ?');
  let changed = 0;
  let lastId = 0;
  for (;;) {
    const rows = select.all(lastId);
    if (rows.length === 0) break;
    for (const r of rows) {
      const { vals, dirty } = migrateRowValues(key, r);
      if (dirty) {
        update.run(...SENSITIVE_COLS.map((c) => vals[c]), r.id);
        changed++;
      }
    }
    lastId = rows[rows.length - 1].id;
  }
  return changed;
}

/** بازرمز همه ستون‌ها با کلید جدید (تغییر رمز admin)؛ مقادیر رمزنشده هم مستقیم با کلید جدید رمز می‌شوند */
function reencryptAll(db, oldKey, newKey) {
  const select = db.prepare(`SELECT id, ${SENSITIVE_COLS.join(', ')} FROM persons WHERE id > ? ORDER BY id LIMIT 500`);
  const update = db.prepare('UPDATE persons SET ' + SENSITIVE_COLS.map((c) => c + ' = ?').join(', ') + ' WHERE id = ?');
  let lastId = 0;
  for (;;) {
    const rows = select.all(lastId);
    if (rows.length === 0) break;
    for (const r of rows) {
      const vals = {};
      for (const col of SENSITIVE_COLS) {
        if (!r[col]) vals[col] = '';
        else if (isEncrypted(r[col])) vals[col] = encryptValue(newKey, decryptValue(oldKey, r[col]));
        else vals[col] = encryptValue(newKey, r[col]);
      }
      update.run(...SENSITIVE_COLS.map((c) => vals[c]), r.id);
    }
    lastId = rows[rows.length - 1].id;
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
  dekFingerprint,
  readDekFingerprint,
  writeDekFingerprint,
  isFingerprintExpected,
  isEncrypted,
  encryptValue,
  decryptValue,
  encryptPersonFields,
  decryptRow,
  migratePlaintext,
  reencryptAll,
};
