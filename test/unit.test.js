'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toLatinDigits, cleanText, searchKey } = require('../lib/text');
const { parseCsv, stringifyCsv, safeCell } = require('../lib/csv');
const { parsePerson } = require('../lib/directory');
const auth = require('../lib/auth');
const enc = require('../lib/crypto');

test('toLatinDigits: ارقام فارسی و عربی به لاتین', () => {
  assert.equal(toLatinDigits('۰۹۱۲٣٤٥'), '0912345');
});

test('cleanText: ی/ک عربی یکسان و فاصله‌ها فشرده می‌شوند', () => {
  assert.equal(cleanText('  علي   كريمي \n'), 'علی کریمی');
});

test('searchKey: نیم‌فاصله و اعراب حذف و ارقام لاتین می‌شوند', () => {
  assert.equal(searchKey('می‌خواهم ۱۲۳'), 'میخواهم 123');
  assert.equal(searchKey('كَريمي'), 'کریمی');
});

test('parseCsv: کوتیشن، ویرگول و خط جدید داخل فیلد، BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi""\nline2"\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"\nline2']]);
});

test('parseCsv: جداکننده نقطه‌ویرگول تشخیص داده می‌شود', () => {
  assert.deepEqual(parseCsv('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
});

test('safeCell: جلوگیری از formula injection ولی شماره با + سالم می‌ماند', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(safeCell('-cmd'), "'-cmd");
  assert.equal(safeCell('+98912'), '+98912');
  assert.equal(safeCell('علی'), 'علی');
});

test('stringifyCsv/parseCsv رفت‌وبرگشت', () => {
  const rows = [['نام', 'یادداشت'], ['علی', 'خط۱\nخط۲, "نقل"']];
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
});

test('parsePerson: نرمال‌سازی و اعتبارسنجی', () => {
  const p = parsePerson({ first_name: ' علي ', mobile: '۰۹۰۰-۰۰۰ ۱۲۳۴', national_id: '۰۰۰۰۰۰۱۲۳۴', extension: '۳۱۰۰' });
  assert.equal(p.first_name, 'علی');
  assert.equal(p.mobile, '09000001234');
  assert.equal(p.national_id, '0000001234');
  assert.equal(p.extension, '3100');
  assert.equal(p.group_id, null);
  assert.throws(() => parsePerson({}), /الزامی/);
  assert.throws(() => parsePerson({ first_name: 'a', national_id: '123' }), /۱۰ رقم/);
  assert.throws(() => parsePerson({ first_name: 'a', extension: '12ab' }), /کد داخلی/);
  assert.throws(() => parsePerson({ first_name: 'a', email: 'nope' }), /ایمیل/);
  assert.throws(() => parsePerson({ first_name: { x: 1 } }), /نامعتبر/);
});

test('scrypt: هش و تأیید رمز؛ هش ثابت نیست', async () => {
  const h1 = await auth.hashPassword('Secret-123');
  const h2 = await auth.hashPassword('Secret-123');
  assert.notEqual(h1, h2);
  assert.equal(await auth.verifyPassword('Secret-123', h1), true);
  assert.equal(await auth.verifyPassword('wrong', h1), false);
  assert.equal(await auth.verifyPassword('anything', null), false);
});

test('crypto: رفت‌وبرگشت AES-GCM؛ رشته خالی همان خالی می‌ماند', () => {
  const key = Buffer.alloc(32, 7);
  const cipher = enc.encryptValue(key, '09000001111');
  assert.ok(cipher.startsWith('enc1:'));
  assert.notEqual(cipher, '09000001111');
  assert.equal(enc.decryptValue(key, cipher), '09000001111');
  assert.equal(enc.encryptValue(key, ''), '');
  assert.equal(enc.decryptValue(key, ''), '');
  assert.equal(enc.decryptValue(key, 'متن رمزنشده قدیمی'), 'متن رمزنشده قدیمی');
});

test('crypto: کلید اشتباه یا متن دست‌کاری‌شده رمزگشایی نمی‌شود', () => {
  const key = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 9);
  const cipher = enc.encryptValue(key, '09000001111');
  assert.throws(() => enc.decryptValue(other, cipher));
  const tampered = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'B' : 'A');
  assert.throws(() => enc.decryptValue(key, tampered));
});

test('crypto: دو بار رمز کردن یک مقدار، خروجی متفاوت می‌دهد (IV تصادفی)', () => {
  const key = Buffer.alloc(32, 7);
  assert.notEqual(enc.encryptValue(key, '09000001111'), enc.encryptValue(key, '09000001111'));
});

test('crypto: isEncrypted فقط پاکت کامل را قبول می‌کند، نه صرف پیشوند را', () => {
  const key = Buffer.alloc(32, 7);
  const real = enc.encryptValue(key, '09000001111');
  assert.equal(enc.isEncrypted(real), true);
  assert.equal(enc.isEncrypted('enc1: reception'), false, 'آدرس قدیمی با پیشوند enc1: نباید رمز شده شمرده شود');
  assert.equal(enc.isEncrypted('enc1:abcd:efgh'), false, 'IV با طول اشتباه پاکت معتبر نیست');
  assert.equal(enc.isEncrypted('enc1:'), false);
  assert.equal(enc.isEncrypted(''), false);
  assert.equal(enc.isEncrypted('متن رمزنشده قدیمی'), false);
  // مقدار قدیمیِ دارای پیشوند، رمزگشایی‌اش همان مقدار است (نه خطا) تا
  // مهاجرت بتواند آن را رمز کند، نه اینکه خواندن را خراب کند
  assert.equal(enc.decryptValue(key, 'enc1: reception'), 'enc1: reception');
});

test('crypto: مهاجرت مقدار قدیمی با پیشوند enc1: را رمز می‌کند و دسته‌ای کار می‌کند', () => {
  const { openDb } = require('../lib/db');
  const db = openDb(':memory:');
  try {
    const key = Buffer.alloc(32, 7);
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO persons (first_name, last_name, title, group_id, extension, direct_line,
         mobile, home_phone, email, address, national_id, note, created_at, updated_at)
       VALUES (?, ?, '', NULL, '', '', ?, '', '', ?, '', '', ?, ?)`,
    );
    // ۱۲۰۰ ردیف: از مرز دسته ۵۰۰تایی رد می‌شود تا دسته‌بندی تست شود
    for (let i = 0; i < 1200; i++) {
      ins.run('قدیمی' + i, 'ردیف', '0900000' + String(1000 + (i % 9000)).padStart(4, '0'), i === 0 ? 'enc1: reception' : '', now, now);
    }
    const changed = enc.migratePlaintext(db, key);
    assert.equal(changed, 1200);
    const first = db.prepare('SELECT mobile, address FROM persons ORDER BY id LIMIT 1').get();
    assert.ok(enc.isEncrypted(first.mobile));
    assert.equal(enc.decryptValue(key, first.mobile).startsWith('0900000'), true);
    assert.ok(enc.isEncrypted(first.address));
    assert.equal(enc.decryptValue(key, first.address), 'enc1: reception');
    // اجرای دوباره idempotent است: چیزی برای تغییر نیست
    assert.equal(enc.migratePlaintext(db, key), 0);
  } finally {
    db.close();
  }
});
