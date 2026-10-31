'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const { toLatinDigits, cleanText, searchKey } = require('./text');
const { transaction } = require('./db');
const { parseCsv, stringifyCsv } = require('./csv');
const { getDek, requireDek, encryptPersonFields, decryptRow, SENSITIVE_COLS, isEncrypted, assertDekCurrent } = require('./crypto');

const collator = new Intl.Collator('fa');

// ───────────────────────── ثابت‌ها ─────────────────────────

const PERSON_COLS = [
  'first_name', 'last_name', 'title', 'group_id', 'extension', 'direct_line',
  'mobile', 'home_phone', 'email', 'address', 'national_id', 'note',
];
// فیلدهایی که viewer هم می‌بیند (کاری)
const COMMON_OUT = [
  'id', 'first_name', 'last_name', 'title', 'group_id', 'group_name', 'group_color',
  'extension', 'direct_line', 'note',
];
// فقط operator (قانون طلایی داده حساس)
const SENSITIVE_OUT = ['mobile', 'home_phone', 'email', 'address', 'national_id', 'created_at', 'updated_at'];

const VIEWER_PHONE_FIELDS = ['extension', 'direct_line'];
const OPERATOR_PHONE_FIELDS = ['extension', 'direct_line', 'mobile', 'home_phone'];
const TYPE_FIELD = { internal: 'extension', direct: 'direct_line', mobile: 'mobile', home: 'home_phone' };

const CSV_COLS = [
  ['first_name', 'نام'], ['last_name', 'نام خانوادگی'], ['title', 'سمت'], ['group', 'گروه'],
  ['extension', 'کد داخلی'], ['direct_line', 'خط مستقیم'], ['mobile', 'موبایل'],
  ['home_phone', 'تلفن منزل'], ['email', 'ایمیل'], ['address', 'آدرس'],
  ['national_id', 'کد ملی'], ['note', 'یادداشت'],
];

const GROUP_PALETTE = ['#2563eb', '#db2777', '#7c3aed', '#ea580c', '#0d9488', '#ca8a04', '#16a34a', '#475569'];

const PERSON_SELECT = `
  SELECT p.*, g.name AS group_name, g.color AS group_color
    FROM persons p LEFT JOIN groups g ON g.id = p.group_id`;

// ───────────────────────── اعتبارسنجی ─────────────────────────

function textField(input, key, max, label) {
  const v = input[key];
  if (v != null && typeof v !== 'string' && typeof v !== 'number') {
    throw new HttpError(400, `${label} نامعتبر است`);
  }
  const s = cleanText(v);
  if (s.length > max) throw new HttpError(400, `${label} حداکثر ${max} نویسه می‌تواند باشد`);
  return s;
}

function phoneField(value, label, re = /^\+?\d{2,15}$/) {
  const s = toLatinDigits(value ?? '').replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (!re.test(s)) throw new HttpError(400, `${label} نامعتبر است`);
  return s;
}

function parsePerson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'داده نامعتبر است');
  }
  const p = {
    first_name: textField(input, 'first_name', 60, 'نام'),
    last_name: textField(input, 'last_name', 60, 'نام خانوادگی'),
    title: textField(input, 'title', 80, 'سمت'),
    address: textField(input, 'address', 300, 'آدرس'),
    note: textField(input, 'note', 300, 'یادداشت'),
  };
  if (!p.first_name && !p.last_name) throw new HttpError(400, 'نام یا نام خانوادگی الزامی است');

  p.extension = phoneField(input.extension, 'کد داخلی', /^\d{1,6}$/);
  p.direct_line = phoneField(input.direct_line, 'خط مستقیم');
  p.mobile = phoneField(input.mobile, 'موبایل', /^\+?\d{7,15}$/);
  p.home_phone = phoneField(input.home_phone, 'تلفن منزل');

  p.email = textField(input, 'email', 120, 'ایمیل');
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new HttpError(400, 'ایمیل نامعتبر است');

  p.national_id = toLatinDigits(textField(input, 'national_id', 20, 'کد ملی')).replace(/\s/g, '');
  if (p.national_id && !/^\d{10}$/.test(p.national_id)) throw new HttpError(400, 'کد ملی باید ۱۰ رقم باشد');

  const g = input.group_id;
  if (g == null || g === '') p.group_id = null;
  else {
    const n = Number(g);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'گروه نامعتبر است');
    p.group_id = n;
  }
  return p;
}

function parseGroup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'داده نامعتبر است');
  const name = textField(input, 'name', 40, 'نام گروه');
  if (!name) throw new HttpError(400, 'نام گروه الزامی است');
  let color = typeof input.color === 'string' ? input.color.trim().toLowerCase() : GROUP_PALETTE[0];
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, 'رنگ باید به شکل #RRGGBB باشد');
  return { name, color };
}

function parseInternal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'داده نامعتبر است');
  const department = textField(input, 'department', 80, 'نام بخش');
  if (!department) throw new HttpError(400, 'نام بخش الزامی است');
  const number = toLatinDigits(textField(input, 'number', 20, 'شماره داخلی'));
  if (!/^\d[\d\-/, ]{0,19}$/.test(number)) throw new HttpError(400, 'شماره داخلی نامعتبر است');
  const note = textField(input, 'note', 120, 'توضیح');
  return { department, number, note };
}

function isUnique(err) {
  return /UNIQUE/i.test(String(err && err.message));
}

// ───────────────────────── مخاطبین ─────────────────────────

function serializePerson(row, role, favSet) {
  const out = {};
  for (const k of COMMON_OUT) out[k] = row[k] ?? null;
  if (role === 'operator') for (const k of SENSITIVE_OUT) out[k] = row[k];
  out.favorite = favSet.has(row.id);
  return out;
}

function favoriteSet(db, userId) {
  return new Set(db.prepare('SELECT person_id FROM favorites WHERE user_id = ?').all(userId).map((r) => r.person_id));
}

function checkGroup(db, groupId) {
  if (groupId == null) return;
  if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) throw new HttpError(400, 'گروه نامعتبر است');
}

function getPerson(db, user, id) {
  const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'مخاطب پیدا نشد');
  const shown = user.role === 'operator' ? decryptRow(requireDek(), row) : row;
  return serializePerson(shown, user.role, favoriteSet(db, user.id));
}

/**
 * جستجو + فیلتر. جستجو در JS انجام می‌شود تا نرمال‌سازی فارسی (ارقام، ی/ک، نیم‌فاصله) یکدست باشد.
 * viewer هرگز بر اساس فیلدهای حساس جستجو یا فیلتر نمی‌کند.
 */
function searchPersons(db, user, { q = '', group = null, type = '', fav = false, limit = 500 } = {}) {
  const isOp = user.role === 'operator';
  if (type && !TYPE_FIELD[type]) throw new HttpError(400, 'نوع شماره نامعتبر است');
  if (!isOp && (type === 'mobile' || type === 'home')) throw new HttpError(403, 'دسترسی کافی ندارید');

  const phoneFields = isOp ? OPERATOR_PHONE_FIELDS : VIEWER_PHONE_FIELDS;
  const tokens = searchKey(q).split(' ').filter(Boolean);
  const favSet = favoriteSet(db, user.id);
  const typeField = type ? TYPE_FIELD[type] : null;

  let rows = db.prepare(PERSON_SELECT).all();
  // اپراتور: فیلدهای حساس را رمزگشایی می‌کنیم تا جستجو روی مقدار واقعی انجام شود؛
  // viewer اصلاً به این فیلدها دسترسی ندارد و رمزگشایی نمی‌خواهد.
  if (isOp) {
    const dek = requireDek();
    rows = rows.map((r) => decryptRow(dek, r));
  }
  const matched = [];
  for (const r of rows) {
    if (group != null && r.group_id !== group) continue;
    if (fav && !favSet.has(r.id)) continue;
    if (typeField && !r[typeField]) continue;
    if (tokens.length) {
      const hay = searchKey([r.first_name, r.last_name, r.title, r.group_name ?? '', r.note].join(' '));
      const phones = phoneFields.map((f) => r[f]).join(' ');
      const ok = tokens.every((t) => (/^\+?\d+$/.test(t) ? phones.includes(t.replace('+', '')) : hay.includes(t)));
      if (!ok) continue;
    }
    matched.push(r);
  }
  rows = null;

  const exactExt = (r) => (tokens.length === 1 && r.extension && r.extension === tokens[0] ? 0 : 1);
  matched.sort(
    (a, b) =>
      exactExt(a) - exactExt(b) ||
      collator.compare(a.last_name, b.last_name) ||
      collator.compare(a.first_name, b.first_name),
  );
  return {
    total: matched.length,
    items: matched.slice(0, limit).map((r) => serializePerson(r, user.role, favSet)),
  };
}

function createPerson(db, input) {
  // چک اثر انگشت، رمز کردن و INSERT باید یک تراکنش BEGIN IMMEDIATE
  // باشند: تک‌نخی بودن Node جلوی پروسه جداگانه CLI را نمی‌گیرد و
  // چرخش CLI می‌تواند بین assert و INSERT (دو statement جدا) commit
  // شود. داخل تراکنش، چرخش CLI تا commit صبر می‌کند؛ اگر CLI اول
  // برنده شود، assert اثر تازه را می‌بیند و نوشتن رد می‌شود، و اگر
  // این درخواست اول برنده شود، چرخش CLI ردیف تازه را هم شامل می‌شود.
  return transaction(db, () => {
    const p = parsePerson(input);
    checkGroup(db, p.group_id);
    const stored = encryptPersonFields(assertDekCurrent(db), p);
    const now = Date.now();
    const res = db
      .prepare(
        `INSERT INTO persons (${PERSON_COLS.join(',')}, created_at, updated_at)
         VALUES (${PERSON_COLS.map(() => '?').join(',')}, ?, ?)`,
      )
      .run(...PERSON_COLS.map((k) => stored[k]), now, now);
    return Number(res.lastInsertRowid);
  });
}

function updatePerson(db, id, input) {
  // مانند createPerson: چک، رمز کردن و UPDATE در یک تراکنش
  return transaction(db, () => {
    const p = parsePerson(input);
    checkGroup(db, p.group_id);
    const stored = encryptPersonFields(assertDekCurrent(db), p);
    const res = db
      .prepare(`UPDATE persons SET ${PERSON_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...PERSON_COLS.map((k) => stored[k]), Date.now(), id);
    if (res.changes === 0) throw new HttpError(404, 'مخاطب پیدا نشد');
  });
}

function deletePerson(db, id) {
  const res = db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  if (res.changes === 0) throw new HttpError(404, 'مخاطب پیدا نشد');
}

function assertPerson(db, id) {
  if (!db.prepare('SELECT 1 FROM persons WHERE id = ?').get(id)) throw new HttpError(404, 'مخاطب پیدا نشد');
}

function setFavorite(db, userId, personId, on) {
  assertPerson(db, personId);
  if (on) db.prepare('INSERT OR IGNORE INTO favorites (user_id, person_id) VALUES (?, ?)').run(userId, personId);
  else db.prepare('DELETE FROM favorites WHERE user_id = ? AND person_id = ?').run(userId, personId);
}

const RECENTS_MAX = 30;

function touchRecent(db, userId, personId) {
  assertPerson(db, personId);
  db.prepare(
    `INSERT INTO recents (user_id, person_id, used_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, person_id) DO UPDATE SET used_at = excluded.used_at`,
  ).run(userId, personId, Date.now());
  db.prepare(
    `DELETE FROM recents WHERE user_id = ? AND person_id NOT IN
       (SELECT person_id FROM recents WHERE user_id = ? ORDER BY used_at DESC LIMIT ${RECENTS_MAX})`,
  ).run(userId, userId);
}

function listRecents(db, user) {
  const favSet = favoriteSet(db, user.id);
  const rows = db
    .prepare(
      `SELECT p.*, g.name AS group_name, g.color AS group_color
         FROM recents r JOIN persons p ON p.id = r.person_id
         LEFT JOIN groups g ON g.id = p.group_id
        WHERE r.user_id = ? ORDER BY r.used_at DESC LIMIT ${RECENTS_MAX}`,
    )
    .all(user.id);
  const shown = user.role === 'operator' ? rows.map((r) => decryptRow(requireDek(), r)) : rows;
  return shown.map((r) => serializePerson(r, user.role, favSet));
}

// ───────────────────────── گروه‌ها ─────────────────────────

function listGroups(db) {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.color, COUNT(p.id) AS count
         FROM groups g LEFT JOIN persons p ON p.group_id = g.id GROUP BY g.id`,
    )
    .all()
    .map((r) => ({ id: r.id, name: r.name, color: r.color, count: Number(r.count) }));
  return rows.sort((a, b) => collator.compare(a.name, b.name));
}

function createGroup(db, input) {
  const g = parseGroup(input);
  try {
    const res = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(g.name, g.color);
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, 'گروهی با این نام وجود دارد');
    throw err;
  }
}

function updateGroup(db, id, input) {
  const g = parseGroup(input);
  try {
    const res = db.prepare('UPDATE groups SET name = ?, color = ? WHERE id = ?').run(g.name, g.color, id);
    if (res.changes === 0) throw new HttpError(404, 'گروه پیدا نشد');
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, 'گروهی با این نام وجود دارد');
    throw err;
  }
}

function deleteGroup(db, id) {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM persons WHERE group_id = ?').get(id).n);
  if (n > 0) throw new HttpError(409, `این گروه ${n} مخاطب دارد؛ ابتدا آنها را به گروه دیگری منتقل کنید`);
  const res = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  if (res.changes === 0) throw new HttpError(404, 'گروه پیدا نشد');
}

// ───────────────────────── داخلی‌های بیمارستان ─────────────────────────

function listInternals(db, q = '') {
  const key = searchKey(q);
  const items = db
    .prepare('SELECT id, department, number, note FROM internals')
    .all()
    .map((r) => ({ id: r.id, department: r.department, number: r.number, note: r.note }))
    .filter((r) => {
      if (!key) return true;
      const hay = searchKey(`${r.department} ${r.number} ${r.note}`);
      return key.split(' ').every((t) => hay.includes(t));
    });
  return items.sort((a, b) => collator.compare(a.department, b.department) || collator.compare(a.number, b.number));
}

function createInternal(db, input) {
  const i = parseInternal(input);
  const res = db.prepare('INSERT INTO internals (department, number, note) VALUES (?, ?, ?)').run(i.department, i.number, i.note);
  return Number(res.lastInsertRowid);
}

function updateInternal(db, id, input) {
  const i = parseInternal(input);
  const res = db.prepare('UPDATE internals SET department = ?, number = ?, note = ? WHERE id = ?').run(i.department, i.number, i.note, id);
  if (res.changes === 0) throw new HttpError(404, 'مورد پیدا نشد');
}

function deleteInternal(db, id) {
  const res = db.prepare('DELETE FROM internals WHERE id = ?').run(id);
  if (res.changes === 0) throw new HttpError(404, 'مورد پیدا نشد');
}

// ───────────────────────── آمار ─────────────────────────

function firstLetter(s) {
  const c = Array.from(String(s).trim())[0];
  if (!c) return null;
  return c === 'آ' ? 'ا' : c;
}

function letterDistribution(values) {
  const m = new Map();
  for (const v of values) {
    const l = firstLetter(v);
    if (l) m.set(l, (m.get(l) || 0) + 1);
  }
  return [...m.entries()]
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.letter, b.letter));
}

function stats(db, user) {
  const persons = db.prepare('SELECT id, first_name, last_name, group_id, extension, direct_line, mobile, home_phone FROM persons').all();
  const groups = listGroups(db);
  const perGroup = groups.map((g) => ({ id: g.id, name: g.name, color: g.color, count: g.count }));
  const ungrouped = persons.filter((p) => p.group_id == null).length;
  if (ungrouped > 0) perGroup.push({ id: null, name: 'بدون گروه', color: '#64748b', count: ungrouped });
  perGroup.sort((a, b) => b.count - a.count);

  const out = {
    total: persons.length,
    groups: groups.length,
    per_group: perGroup,
    first_letters: letterDistribution(persons.map((p) => p.first_name)),
    last_letters: letterDistribution(persons.map((p) => p.last_name)),
  };

  // «رکوردهای ناقص» به مقدار شماره‌های حساس وابسته است؛ فقط برای operator
  if (user.role === 'operator') {
    const incomplete = persons.filter((p) => !p.extension && !p.direct_line && !p.mobile && !p.home_phone);
    out.incomplete_count = incomplete.length;
    out.incomplete = incomplete
      .sort((a, b) => collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name))
      .slice(0, 200)
      .map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`.trim() }));
  }
  return out;
}

// ───────────────────────── CSV ─────────────────────────

function exportCsv(db) {
  const dek = requireDek();
  const rows = db.prepare(PERSON_SELECT).all().map((r) => decryptRow(dek, r)).sort(
    (a, b) => collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name),
  );
  const table = [CSV_COLS.map(([, fa]) => fa)];
  for (const r of rows) {
    table.push(CSV_COLS.map(([key]) => (key === 'group' ? r.group_name ?? '' : r[key])));
  }
  return stringifyCsv(table);
}

function importCsv(db, text) {
  const table = parseCsv(text);
  if (table.length < 2) throw new HttpError(400, 'فایل CSV خالی است یا فقط سطر عنوان دارد');
  if (table.length > 20001) throw new HttpError(400, 'حداکثر ۲۰٬۰۰۰ سطر در هر بار ورود مجاز است');

  const alias = new Map();
  for (const [key, fa] of CSV_COLS) {
    alias.set(key, key);
    alias.set(cleanText(fa).toLowerCase(), key);
  }
  const colIndex = {};
  table[0].forEach((h, i) => {
    const key = alias.get(cleanText(h).toLowerCase());
    if (key && !(key in colIndex)) colIndex[key] = i;
  });
  if (!('first_name' in colIndex) && !('last_name' in colIndex)) {
    throw new HttpError(400, 'سطر عنوان باید حداقل ستون «نام» یا «نام خانوادگی» را داشته باشد');
  }

  return transaction(db, () => {
    // چک اثر انگشت داخل تراکنش، پیش از هر رمز کردن؛ از اینجا تا
    // commit هیچ awaitای نیست و قفل SQLite هم جلوی چرخش هم‌زمان را می‌گیرد
    const dek = assertDekCurrent(db);
    const groupIds = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.name, g.id]));
    const dupKey = (p) => [p.first_name, p.last_name, p.extension, p.direct_line, p.mobile, p.home_phone].join('|');
    const seen = new Set(
      db.prepare('SELECT first_name, last_name, extension, direct_line, mobile, home_phone FROM persons').all().map((r) => dupKey(decryptRow(dek, r))),
    );
    const insert = db.prepare(
      `INSERT INTO persons (${PERSON_COLS.join(',')}, created_at, updated_at)
       VALUES (${PERSON_COLS.map(() => '?').join(',')}, ?, ?)`,
    );
    const result = { created: 0, duplicates: 0, failed: 0, errors: [] };
    const now = Date.now();

    for (let r = 1; r < table.length; r++) {
      const cells = table[r];
      if (cells.every((c) => !String(c).trim())) continue; // سطر کاملاً خالی (مثلاً ته فایل اکسل)
      const get = (key) => (key in colIndex ? cells[colIndex[key]] ?? '' : '');
      try {
        const input = {};
        for (const [key] of CSV_COLS) if (key !== 'group') input[key] = get(key);
        const groupName = cleanText(get('group'));
        if (groupName.length > 40) throw new HttpError(400, 'نام گروه بیش از ۴۰ نویسه است');
        input.group_id = null;
        const p = parsePerson(input);
        const key = dupKey(p);
        if (seen.has(key)) {
          result.duplicates++;
          continue;
        }
        if (groupName) {
          if (!groupIds.has(groupName)) {
            const color = GROUP_PALETTE[groupIds.size % GROUP_PALETTE.length];
            const res = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(groupName, color);
            groupIds.set(groupName, Number(res.lastInsertRowid));
          }
          p.group_id = groupIds.get(groupName);
        }
        const stored = encryptPersonFields(dek, p);
        insert.run(...PERSON_COLS.map((k) => stored[k]), now, now);
        seen.add(key);
        result.created++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        result.failed++;
        if (result.errors.length < 50) result.errors.push({ row: r + 1, message: err.message });
      }
    }
    return result;
  });
}

// ───────────────────────── پشتیبان ─────────────────────────

/**
 * وضعیت رمزنگاری پشتیبان‌های .db موجود: هر فایل را فقط‌خواندنی باز
 * می‌کند و برمی‌گرداند که آیا هنوز مقدار حساس رمزنشده دارد یا نه.
 * پشتیبان‌های قدیمی (پیش از ارتقا) به‌صورت خودکار مهاجرت یا حذف
 * نمی‌شوند — حذف خودکارِ پشتیبان، مخرب است — ولی وضعیت‌شان اینجا
 * فعالانه گزارش می‌شود (هشدار راه‌اندازی سرور + دستور audit-backups)
 * تا اپراتور خودش تصمیم بگیرد، نه اینکه ادعای README بی‌پاسخ بماند.
 * فایل خراب/قفل‌شده با error گزارش می‌شود، نه اینکه اسکن را بشکند.
 */
// اسکن یک پشتیبان بازشده: دسته‌ای (۵۰۰تایی) و با خروج زودهنگام در
// اولین مقدار رمزنشده، تا پشتیبان بزرگ کل جدولش یکجا در حافظه ننشیند
// و راه‌اندازی سرور هم بی‌دلیل طول نکشد. تابع جداگانه است تا پیچیدگی
// auditBackups زیر سقف Sonar بماند.
function backupHasPlaintext(copy) {
  const hasPersons = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persons'").get();
  if (!hasPersons) return false;
  const select = copy.prepare(`SELECT id, ${SENSITIVE_COLS.join(', ')} FROM persons WHERE id > ? ORDER BY id LIMIT 500`);
  let lastId = 0;
  for (;;) {
    const rows = select.all(lastId);
    if (rows.length === 0) return false;
    if (rows.some((r) => SENSITIVE_COLS.some((col) => r[col] && !isEncrypted(r[col])))) return true;
    lastId = rows[rows.length - 1].id;
  }
}

function auditBackups(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(dataDir, 'backups');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  } catch {
    return [];
  }
  const results = [];
  for (const file of files) {
    try {
      const copy = new DatabaseSync(path.join(dir, file), { readOnly: true });
      try {
        results.push({ file, plaintext: backupHasPlaintext(copy) });
      } finally {
        copy.close();
      }
    } catch (err) {
      results.push({ file, plaintext: null, error: err.message });
    }
  }
  return results;
}

function backupDb(db, dataDir) {
  // دفاع دومِ لایه پشتیبان (لایه اول: مسیر /api/backup در حالت قفل
  // 401 می‌دهد): اگر هنوز ردیف رمزنشده‌ای مانده باشد — مثلاً seed
  // وقتی سرور در حال اجرا بوده داده ریخته، یا مهاجرت هنوز انجام نشده
  // — کپی‌ای که حاوی ستون حساس خواناست ساخته نمی‌شود.
  const rows = db.prepare(`SELECT ${SENSITIVE_COLS.join(', ')} FROM persons`).all();
  for (const r of rows) {
    for (const col of SENSITIVE_COLS) {
      if (r[col] && !isEncrypted(r[col])) {
        throw new HttpError(409, 'پشتیبان ساخته نشد: هنوز مقادیر حساس رمزنشده در دیتابیس هست؛ اول admin وارد شود تا مهاجرت انجام شود');
      }
    }
  }
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name =
    `directory-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.db`;
  // VACUUM INTO یک کپی سازگار از دیتابیس می‌سازد، حتی وسط کار سرور
  db.prepare('VACUUM INTO ?').run(path.join(dir, name));
  const old = fs.readdirSync(dir).filter((f) => /^directory-[\d-]+\.db$/.test(f)).sort().reverse().slice(30);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return name;
}

module.exports = {
  parsePerson,
  getPerson,
  searchPersons,
  createPerson,
  updatePerson,
  deletePerson,
  setFavorite,
  touchRecent,
  listRecents,
  auditBackups,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listInternals,
  createInternal,
  updateInternal,
  deleteInternal,
  stats,
  exportCsv,
  importCsv,
  backupDb,
  GROUP_PALETTE,
};
