'use strict';

/**
 * پر کردن دیتابیس با داده‌های کاملاً ساختگی برای آزمایش و نمایش.
 *   node seed.js            فقط اگر دیتابیس خالی باشد
 *   node seed.js --reset    ابتدا همه داده‌های موجود را پاک می‌کند (احتیاط!)
 *
 * همه نام‌ها، شماره‌ها، کدهای ملی، ایمیل‌ها و آدرس‌ها ساختگی‌اند:
 *   موبایل 0900000xxxx، تلفن 021555xxxxx، کد ملی 000000xxxx (نامعتبر عمداً)،
 *   ایمیل @example.test (دامنه رزروشده برای تست).
 * مقادیر حساس به‌صورت رمزنشده نوشته می‌شوند و در اولین ورود admin رمز می‌شوند.
 */

const { loadConfig, requireNode22 } = require('./lib/config');
const { openDb, transaction } = require('./lib/db');
const auth = require('./lib/auth');
const { writeSnapshot } = require('./lib/snapshot');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['علی', 'محمد', 'حسین', 'رضا', 'مهدی', 'امیر', 'سعید', 'حمید', 'کاوه', 'پوریا', 'سارا', 'مریم', 'زهرا', 'فاطمه', 'نرگس', 'الهه', 'مینا', 'شیما', 'نگار', 'ندا'];
const LAST = ['احمدی', 'رضایی', 'کریمی', 'حسینی', 'موسوی', 'صادقی', 'جعفری', 'نوری', 'رحیمی', 'کاظمی', 'فراهانی', 'سلطانی', 'یزدانی', 'مرادی', 'قنبری', 'زارعی'];

const GROUPS = [
  { name: 'پزشکان', color: '#2563eb', count: 14, extBase: 3100, titles: ['متخصص قلب', 'متخصص داخلی', 'جراح عمومی', 'پزشک اورژانس', 'متخصص اطفال', 'متخصص بیهوشی', 'رادیولوژیست'] },
  { name: 'پرستاران', color: '#db2777', count: 14, extBase: 3200, titles: ['سرپرستار', 'پرستار', 'سوپروایزر', 'پرستار ICU'] },
  { name: 'اداری', color: '#7c3aed', count: 8, extBase: 3300, titles: ['مسئول پذیرش', 'کارشناس حسابداری', 'مسئول دبیرخانه', 'کارشناس منابع انسانی'] },
  { name: 'خدمات', color: '#ea580c', count: 6, extBase: 3400, titles: ['سرپرست خدمات', 'مسئول تغذیه', 'راننده آمبولانس'] },
  { name: 'فنی و تأسیسات', color: '#0d9488', count: 6, extBase: 3500, titles: ['مسئول تأسیسات', 'کارشناس تجهیزات پزشکی', 'کارشناس IT'] },
  { name: 'آزمایشگاه', color: '#ca8a04', count: 5, extBase: 3600, titles: ['مسئول آزمایشگاه', 'کارشناس آزمایشگاه'] },
  { name: 'داروخانه', color: '#16a34a', count: 4, extBase: 3700, titles: ['مسئول فنی داروخانه', 'دکتر داروساز'] },
  { name: 'حراست', color: '#475569', count: 4, extBase: 3800, titles: ['مسئول حراست', 'نگهبان شیفت'] },
];

const INTERNALS = [
  ['اورژانس', '101', ''], ['پذیرش', '110', ''], ['ترخیص', '111', ''], ['حسابداری', '120', ''],
  ['دبیرخانه', '121', ''], ['منابع انسانی', '122', ''], ['مرکز آمار', '125', ''], ['مدیریت', '130', ''],
  ['ریاست', '131', 'فقط ساعات اداری'], ['آزمایشگاه', '140', ''], ['رادیولوژی', '150', ''], ['سونوگرافی', '151', ''],
  ['داروخانه', '160', ''], ['داروخانه شبانه‌روزی', '161', 'شب‌ها و ایام تعطیل'], ['ICU', '201', ''], ['CCU', '202', ''],
  ['NICU', '203', ''], ['اتاق عمل', '210', ''], ['بخش داخلی', '220', 'ایستگاه پرستاری'], ['بخش جراحی', '221', 'ایستگاه پرستاری'],
  ['بخش اطفال', '222', 'ایستگاه پرستاری'], ['زنان و زایمان', '223', ''], ['تأسیسات', '301', ''], ['IT', '302', ''],
  ['حراست', '310', '۲۴ ساعته'], ['آشپزخانه', '320', ''], ['رختشویخانه', '321', ''], ['آمبولانس', '330', ''],
];

function buildPersons(groupIds) {
  const rnd = mulberry32(20261031);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const persons = [];
  let i = 0;
  for (const g of GROUPS) {
    for (let k = 0; k < g.count; k++, i++) {
      const n = 1000 + i;
      persons.push({
        first_name: pick(FIRST),
        last_name: pick(LAST),
        title: pick(g.titles),
        group_id: groupIds.get(g.name),
        extension: rnd() < 0.7 ? String(g.extBase + k) : '',
        direct_line: rnd() < 0.25 ? `0215559${n}` : '',
        mobile: rnd() < 0.9 ? `0900000${n}` : '',
        home_phone: rnd() < 0.5 ? `0215550${n}` : '',
        email: rnd() < 0.4 ? `user${n}@example.test` : '',
        address: rnd() < 0.5 ? `خیابان نمونه، کوچه فرضی ${1 + Math.floor(rnd() * 20)}، پلاک ${1 + Math.floor(rnd() * 90)}` : '',
        national_id: rnd() < 0.5 ? `000000${n}` : '',
        note: rnd() < 0.12 ? 'بعد از ۲۲ فقط سوپروایزر' : '',
      });
    }
  }
  // چند رکورد ناقص (بدون هیچ شماره) برای نمایش در آمار
  for (const [first, last, title, group] of [
    ['نمونه', 'یکم', 'کارشناس', 'اداری'],
    ['نمونه', 'دوم', 'پرستار', 'پرستاران'],
    ['نمونه', 'سوم', 'نگهبان', 'حراست'],
  ]) {
    persons.push({
      first_name: first, last_name: last, title, group_id: groupIds.get(group),
      extension: '', direct_line: '', mobile: '', home_phone: '', email: '', address: '', national_id: '', note: '',
    });
  }
  return persons;
}

async function main() {
  requireNode22();
  const cfg = loadConfig();
  const reset = process.argv.includes('--reset');
  const db = openDb(cfg.dbFile);

  const existing = Number(db.prepare('SELECT (SELECT COUNT(*) FROM persons) + (SELECT COUNT(*) FROM internals) AS n').get().n);
  if (existing > 0 && !reset) {
    console.error(`دیتابیس خالی نیست (${cfg.dbFile}). برای پاک‌کردن و ساخت دوباره: node seed.js --reset`);
    process.exit(1);
  }

  const now = Date.now();
  transaction(db, () => {
    if (reset) {
      for (const t of ['recents', 'favorites', 'sessions', 'persons', 'internals', 'groups', 'users']) {
        db.exec(`DELETE FROM ${t}`);
      }
    }
    const groupIds = new Map();
    for (const g of GROUPS) {
      const r = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(g.name, g.color);
      groupIds.set(g.name, Number(r.lastInsertRowid));
    }
    const insP = db.prepare(
      `INSERT INTO persons (first_name,last_name,title,group_id,extension,direct_line,mobile,home_phone,email,address,national_id,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of buildPersons(groupIds)) {
      insP.run(p.first_name, p.last_name, p.title, p.group_id, p.extension, p.direct_line, p.mobile, p.home_phone, p.email, p.address, p.national_id, p.note, now, now);
    }
    const insI = db.prepare('INSERT INTO internals (department, number, note) VALUES (?, ?, ?)');
    for (const [d, n, note] of INTERNALS) insI.run(d, n, note);
  });

  writeSnapshot(db, cfg.publicDir);

  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM persons) p, (SELECT COUNT(*) FROM groups) g, (SELECT COUNT(*) FROM internals) i').get();
  console.log(`داده ساختگی ساخته شد: ${counts.p} مخاطب، ${counts.g} گروه، ${counts.i} داخلی`);
  console.log('کاربر admin در اولین اجرای سرور ساخته می‌شود (رمز تصادفی یک‌بار در ترمینال چاپ می‌شود).');
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
