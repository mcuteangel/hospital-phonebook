'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');
const { openDb } = require('../lib/db');
const auth = require('../lib/auth');
const enc = require('../lib/crypto');
const dir = require('../lib/directory');

// داده‌های کاملاً ساختگی
const FAKE_MOBILE = '09000001111';
const FAKE_HOME = '02155501111';
const FAKE_NID = '0000001111';
const FAKE_EMAIL = 'fake1111@example.test';
const FAKE_ADDRESS = 'خیابان نمونه، پلاک ۱۱۱۱';

let tmp, db, server, base, publicDir;
const ctx = { groupId: null };

function client() {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (body !== undefined) {
      if (typeof body === 'string') {
        init.headers['Content-Type'] ??= 'text/csv; charset=utf-8';
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    cookie: () => cookie,
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b, h),
    put: (u, b, h) => call('PUT', u, b, h),
    del: (u, h) => call('DELETE', u, undefined, h),
    login: async (username, password) => {
      const r = await call('POST', '/api/login', { username, password });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r;
    },
  };
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phonebook-test-'));
  publicDir = path.join(tmp, 'public');
  fs.cpSync(path.join(__dirname, '..', 'public'), publicDir, { recursive: true });
  db = openDb(path.join(tmp, 'data', 'directory.db'));
  await auth.createUser(db, 'oper', 'operator', 'Operator-Test-1');
  await auth.createUser(db, 'viewer1', 'viewer', 'Viewer-Test-1');
  await auth.createUser(db, 'admin', 'operator', 'Admin-Test-1');
  ctx.salt = enc.getOrCreateSalt(db);
  enc.setDek(await enc.deriveDek('Admin-Test-1', ctx.salt));
  ctx.groupId = dir.createGroup(db, { name: 'پزشکان', color: '#2563eb' });
  dir.createGroup(db, { name: 'خالی', color: '#16a34a' });
  dir.createPerson(db, {
    first_name: 'علی', last_name: 'کریمی', title: 'متخصص قلب', group_id: ctx.groupId,
    extension: '3101', direct_line: '02155509999', mobile: FAKE_MOBILE, home_phone: FAKE_HOME,
    email: FAKE_EMAIL, address: FAKE_ADDRESS, national_id: FAKE_NID, note: 'بعد از ۲۲ فقط سوپروایزر',
  });
  dir.createPerson(db, { first_name: 'مریم', last_name: 'رضایی', title: 'پرستار', extension: '3102' });
  dir.createPerson(db, { first_name: 'نمونه', last_name: 'ناقص' });
  dir.createInternal(db, { department: 'اورژانس', number: '101', note: '' });
  dir.createInternal(db, { department: 'پذیرش', number: '110', note: '' });
  server = createApp({ db, publicDir, dataDir: path.join(tmp, 'data') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('داخلی‌ها بدون ورود در دسترس‌اند؛ مخاطبین و آمار نه', async () => {
  const c = client();
  const r = await c.get('/api/internals');
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 2);
  assert.equal((await c.get('/api/persons')).status, 401);
  assert.equal((await c.get('/api/stats')).status, 401);
  assert.equal((await c.get('/api/groups')).status, 401);
  assert.equal((await c.get('/api/export.csv')).status, 401);
});

test('جستجوی داخلی‌ها با رقم فارسی و نام فارسی', async () => {
  const c = client();
  assert.deepEqual((await c.get('/api/internals?q=' + encodeURIComponent('۱۰۱'))).data.items.map((i) => i.department), ['اورژانس']);
  assert.deepEqual((await c.get('/api/internals?q=' + encodeURIComponent('پذیرش'))).data.items.map((i) => i.number), ['110']);
});

test('ورود: رمز اشتباه رد می‌شود، کوکی HttpOnly و SameSite=Strict است', async () => {
  const c = client();
  const bad = await c.post('/api/login', { username: 'oper', password: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await c.post('/api/login', { username: 'oper', password: 'Operator-Test-1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.user, { username: 'oper', role: 'operator', mustChangePassword: false });
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await c.get('/api/me')).data.user.username, 'oper');
});

test('viewer: هیچ فیلد حساسی برنمی‌گردد و بر اساس آنها جستجو/فیلتر نمی‌شود', async () => {
  const c = client();
  await c.login('viewer1', 'Viewer-Test-1');

  const list = await c.get('/api/persons');
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.data);
  for (const secret of [FAKE_MOBILE, FAKE_HOME, FAKE_NID, FAKE_EMAIL, FAKE_ADDRESS]) {
    assert.ok(!raw.includes(secret), `نشت داده حساس: ${secret}`);
  }
  const ali = list.data.items.find((p) => p.last_name === 'کریمی');
  assert.equal(ali.extension, '3101');
  assert.equal(ali.direct_line, '02155509999');
  for (const k of ['mobile', 'home_phone', 'email', 'address', 'national_id']) assert.ok(!(k in ali), k);

  const detail = await c.get(`/api/persons/${ali.id}`);
  assert.ok(!JSON.stringify(detail.data).includes(FAKE_MOBILE));

  // جستجو با شماره موبایل نباید چیزی پیدا کند (نشت وجود شماره)
  assert.equal((await c.get('/api/persons?q=' + FAKE_MOBILE)).data.total, 0);
  assert.equal((await c.get('/api/persons?q=' + FAKE_HOME)).data.total, 0);
  assert.equal((await c.get('/api/persons?type=mobile')).status, 403);
  assert.equal((await c.get('/api/persons?type=home')).status, 403);
  // شماره کاری قابل جستجو است
  assert.equal((await c.get('/api/persons?q=02155509999')).data.total, 1);

  // فقط خواندن
  assert.equal((await c.post('/api/persons', { first_name: 'x' })).status, 403);
  assert.equal((await c.put(`/api/persons/${ali.id}`, { first_name: 'x' })).status, 403);
  assert.equal((await c.del(`/api/persons/${ali.id}`)).status, 403);
  assert.equal((await c.post('/api/groups', { name: 'x' })).status, 403);
  assert.equal((await c.post('/api/internals', { department: 'x', number: '1' })).status, 403);
  assert.equal((await c.get('/api/export.csv')).status, 403);
  assert.equal((await c.post('/api/import', 'نام\nx')).status, 403);
  assert.equal((await c.post('/api/backup', {})).status, 403);

  const stats = await c.get('/api/stats');
  assert.equal(stats.status, 200);
  assert.ok(!('incomplete' in stats.data) && !('incomplete_count' in stats.data));
});

test('operator: همه فیلدها را می‌بیند و با شماره موبایل/منزل جستجو و فیلتر می‌کند', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const r = await c.get('/api/persons?q=' + FAKE_MOBILE);
  assert.equal(r.data.total, 1);
  const p = r.data.items[0];
  assert.equal(p.mobile, FAKE_MOBILE);
  assert.equal(p.national_id, FAKE_NID);
  assert.equal(p.email, FAKE_EMAIL);
  assert.equal((await c.get('/api/persons?type=mobile')).data.total, 1);
  assert.equal((await c.get('/api/persons?type=internal')).data.total, 2);
  assert.equal((await c.get('/api/persons?type=bogus')).status, 400);
});

test('جستجو: ارقام فارسی، ی/ک عربی، چند کلمه و رتبه‌بندی کد داخلی دقیق', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  assert.equal((await c.get('/api/persons?q=' + encodeURIComponent('۳۱۰۱'))).data.items[0].last_name, 'کریمی');
  assert.equal((await c.get('/api/persons?q=' + encodeURIComponent('علي كريمي'))).data.total, 1);
  assert.equal((await c.get('/api/persons?q=' + encodeURIComponent('قلب پزشکان'))).data.total, 1);
  assert.equal((await c.get('/api/persons?q=' + encodeURIComponent('سوپروایزر'))).data.total, 1);
  assert.equal((await c.get('/api/persons?q=zzzz')).data.total, 0);
  assert.equal((await c.get(`/api/persons?group=${ctx.groupId}`)).data.total, 1);
});

test('CRUD مخاطب با اعتبارسنجی و نرمال‌سازی', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  assert.equal((await c.post('/api/persons', {})).status, 400);
  assert.equal((await c.post('/api/persons', { first_name: 'الف', national_id: '123' })).status, 400);
  assert.equal((await c.post('/api/persons', { first_name: 'الف', group_id: 99999 })).status, 400);
  assert.equal((await c.post('/api/persons', 'not json', { 'Content-Type': 'text/plain' })).status, 415);

  const created = await c.post('/api/persons', {
    first_name: 'سارا', last_name: 'نوري', mobile: '۰۹۰۰۰۰۰۲۲۲۲', extension: '۴۴۴۴', group_id: ctx.groupId,
  });
  assert.equal(created.status, 201);
  const p = created.data.person;
  assert.equal(p.last_name, 'نوری');
  assert.equal(p.mobile, '09000002222');
  assert.equal(p.extension, '4444');

  const upd = await c.put(`/api/persons/${p.id}`, { ...p, title: 'سرپرستار' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.person.title, 'سرپرستار');

  assert.equal((await c.del(`/api/persons/${p.id}`)).status, 200);
  assert.equal((await c.get(`/api/persons/${p.id}`)).status, 404);
  assert.equal((await c.del(`/api/persons/${p.id}`)).status, 404);
});

test('گروه‌ها: ایجاد، تکراری، رنگ نامعتبر، حذف گروه دارای عضو', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const g = await c.post('/api/groups', { name: 'آزمایشگاه', color: '#ca8a04' });
  assert.equal(g.status, 201);
  assert.equal((await c.post('/api/groups', { name: 'آزمایشگاه', color: '#ca8a04' })).status, 409);
  assert.equal((await c.post('/api/groups', { name: 'بد', color: 'red' })).status, 400);
  assert.equal((await c.put(`/api/groups/${g.data.id}`, { name: 'آزمایشگاه مرکزی', color: '#111111' })).status, 200);
  assert.equal((await c.del(`/api/groups/${ctx.groupId}`)).status, 409);
  assert.equal((await c.del(`/api/groups/${g.data.id}`)).status, 200);
  const names = (await c.get('/api/groups')).data.items.map((x) => x.name);
  assert.ok(names.includes('پزشکان') && !names.includes('آزمایشگاه مرکزی'));
});

test('داخلی‌ها: CRUD توسط operator و به‌روزرسانی snapshot استاتیک فقط با داخلی‌ها', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  assert.equal((await c.post('/api/internals', { department: 'x', number: 'abc' })).status, 400);
  const created = await c.post('/api/internals', { department: 'آشپزخانه', number: '۳۲۰', note: 'نمونه' });
  assert.equal(created.status, 201);

  const snap = fs.readFileSync(path.join(publicDir, 'internals-snapshot.js'), 'utf8');
  assert.match(snap, /آشپزخانه/);
  assert.match(snap, /"320"/);
  for (const secret of [FAKE_MOBILE, FAKE_HOME, FAKE_NID, FAKE_EMAIL, 'کریمی']) assert.ok(!snap.includes(secret));

  assert.equal((await c.put(`/api/internals/${created.data.id}`, { department: 'آشپزخانه', number: '321', note: '' })).status, 200);
  assert.equal((await c.del(`/api/internals/${created.data.id}`)).status, 200);
  assert.ok(!fs.readFileSync(path.join(publicDir, 'internals-snapshot.js'), 'utf8').includes('آشپزخانه'));
});

test('علاقه‌مندی‌ها و اخیرها به‌ازای هر کاربر', async () => {
  const op = client();
  const viewer = client();
  await op.login('oper', 'Operator-Test-1');
  await viewer.login('viewer1', 'Viewer-Test-1');
  const id = (await op.get('/api/persons?q=' + encodeURIComponent('کریمی'))).data.items[0].id;

  assert.equal((await op.put(`/api/persons/${id}/favorite`)).status, 200);
  assert.equal((await op.get('/api/persons?fav=1')).data.total, 1);
  assert.equal((await viewer.get('/api/persons?fav=1')).data.total, 0);
  assert.equal((await op.del(`/api/persons/${id}/favorite`)).status, 200);
  assert.equal((await op.get('/api/persons?fav=1')).data.total, 0);
  assert.equal((await op.put('/api/persons/999999/favorite')).status, 404);

  assert.equal((await op.post(`/api/persons/${id}/touch`, {})).status, 200);
  assert.equal((await op.get('/api/recents')).data.items[0].id, id);
  assert.equal((await viewer.get('/api/recents')).data.items.length, 0);
});

test('آمار: شمارش‌ها، توزیع حرف اول و رکوردهای ناقص (فقط operator)', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const s = (await c.get('/api/stats')).data;
  assert.equal(s.total, 3);
  assert.ok(s.groups >= 2);
  assert.equal(s.per_group.find((g) => g.name === 'پزشکان').count, 1);
  assert.ok(s.per_group.some((g) => g.name === 'بدون گروه' && g.count === 2));
  assert.ok(s.first_letters.some((x) => x.letter === 'ع' && x.count === 1));
  assert.ok(s.last_letters.some((x) => x.letter === 'ک'));
  assert.equal(s.incomplete_count, 1);
  assert.equal(s.incomplete[0].name, 'نمونه ناقص');
});

test('CSV: خروجی با BOM، جلوگیری از formula injection، ورود با گروه جدید و تکراری‌ها', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');

  const exp = await c.get('/api/export.csv');
  assert.equal(exp.status, 200);
  const rawBytes = Buffer.from(await (await fetch(base + '/api/export.csv', { headers: { Cookie: c.cookie() } })).arrayBuffer());
  assert.deepEqual([...rawBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM باید در بایت‌های خام باشد');
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  assert.ok(exp.data.includes('کریمی') && exp.data.includes(FAKE_MOBILE));

  const csv =
    'نام,نام خانوادگی,سمت,گروه,کد داخلی,موبایل,کد ملی\r\n' +
    'حسین,تست‌ی,=HYPERLINK("http://x"),خدمات,5001,09000003333,0000003333\r\n' +
    'علی,کریمی,متخصص قلب,پزشکان,3101,' + FAKE_MOBILE + ',\r\n' +
    ',,,,,,\r\n' +
    'بد,ردیف,,,,12,\r\n';
  const imp = await c.post('/api/import', csv);
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  // ردیف خالی نادیده گرفته می‌شود؛ ردیف «علی کریمی» بدون شماره‌های دیگر با رکورد موجود یکسان نیست (کلید تکراری شامل همه شماره‌هاست)
  assert.equal(imp.data.created, 2);
  assert.equal(imp.data.failed, 1);
  assert.equal(imp.data.errors[0].row, 5);
  assert.ok((await c.get('/api/groups')).data.items.some((g) => g.name === 'خدمات'));

  const added = (await c.get('/api/persons?q=09000003333')).data.items[0];
  assert.equal(added.title, '=HYPERLINK("http://x")'); // در دیتابیس دست‌نخورده
  const exp2 = await c.get('/api/export.csv');
  assert.ok(exp2.data.includes(`'=HYPERLINK`), 'در خروجی باید خنثی شود');

  // دوباره وارد کردن همان فایل: همه تکراری
  const again = await c.post('/api/import', csv);
  assert.equal(again.data.created, 0);
  assert.equal(again.data.duplicates, 2);

  assert.equal((await c.post('/api/import', 'abc,def\n1,2\n')).status, 400);
  assert.equal((await c.post('/api/import', 'x')).status, 400);
});

test('پشتیبان‌گیری یک کپی قابل‌خواندن از SQLite می‌سازد', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const r = await c.post('/api/backup', {});
  assert.equal(r.status, 201);
  const file = path.join(tmp, 'data', 'backups', r.data.file);
  assert.ok(fs.existsSync(file));
  const copy = openDb(file);
  assert.ok(Number(copy.prepare('SELECT COUNT(*) AS n FROM persons').get().n) >= 3);
  copy.close();
});

test('خروج: نشست باطل می‌شود', async () => {
  const c = client();
  await c.login('viewer1', 'Viewer-Test-1');
  assert.equal((await c.get('/api/persons')).status, 200);
  assert.equal((await c.post('/api/logout', {})).status, 200);
  assert.equal((await c.get('/api/persons')).status, 401);
});

test('تغییر رمز: رمز فعلی لازم است و رمز قدیمی از کار می‌افتد', async () => {
  const c = client();
  await c.login('viewer1', 'Viewer-Test-1');
  assert.equal((await c.post('/api/me/password', { current: 'bad', new: 'New-Password-9' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'Viewer-Test-1', new: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'Viewer-Test-1', new: 'New-Password-9' })).status, 200);
  assert.equal((await client().post('/api/login', { username: 'viewer1', password: 'Viewer-Test-1' })).status, 401);
  await client().login('viewer1', 'New-Password-9');
  // برگرداندن رمز تا تست‌های بعدی با رمز اصلی کار کنند
  const c2 = client();
  await c2.login('viewer1', 'New-Password-9');
  assert.equal((await c2.post('/api/me/password', { current: 'New-Password-9', new: 'Viewer-Test-1' })).status, 200);
});

test('CSRF: درخواست تغییر با Origin بیگانه رد می‌شود', async () => {
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const evil = await c.post('/api/groups', { name: 'هک', color: '#000000' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const same = await c.post('/api/groups', { name: 'مجاز', color: '#000000' }, { Origin: base });
  assert.equal(same.status, 201);
});

test('تغییر رمز اجباری: تا وقتی رمز عوض نشده، بقیه APIها 403 می‌دهند', async () => {
  await auth.createUser(db, 'newadmin', 'operator', 'Newadmin-Test-1', { mustChangePassword: true });
  const c = client();
  const r = await c.login('newadmin', 'Newadmin-Test-1');
  assert.equal(r.data.user.mustChangePassword, true);
  assert.equal((await c.get('/api/persons')).status, 403);
  assert.equal((await c.get('/api/me')).data.user.mustChangePassword, true);
  const ch = await c.post('/api/me/password', { current: 'Newadmin-Test-1', new: 'Newadmin-Test-2' });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.equal((await c.get('/api/me')).data.user.mustChangePassword, false);
  assert.equal((await c.get('/api/persons')).status, 200);
});

test('رمزنگاری: مقادیر حساس در دیتابیس رمز شده‌اند ولی از API خوانا برمی‌گردند', async () => {
  const raw = db.prepare('SELECT mobile FROM persons WHERE last_name = ?').get('کریمی');
  assert.ok(raw.mobile.startsWith('enc1:'), raw.mobile);
  assert.ok(!raw.mobile.includes(FAKE_MOBILE));
  const c = client();
  await c.login('oper', 'Operator-Test-1');
  const p = (await c.get('/api/persons?q=' + FAKE_MOBILE)).data.items[0];
  assert.equal(p.mobile, FAKE_MOBILE);
});

test('قفل: بدون ورود admin، اپراتور به داده حساس نمی‌رسد ولی viewer کار می‌کند', async () => {
  enc.clearDek();
  try {
    const oc = client();
    await oc.login('oper', 'Operator-Test-1');
    const r = await oc.get('/api/persons');
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'locked');
    const vc = client();
    await vc.login('viewer1', 'Viewer-Test-1');
    assert.equal((await vc.get('/api/persons')).status, 200);
  } finally {
    enc.setDek(await enc.deriveDek('Admin-Test-1', ctx.salt));
  }
  const oc = client();
  await oc.login('oper', 'Operator-Test-1');
  assert.equal((await oc.get('/api/persons')).status, 200);
});

test('مهاجرت: مقادیر قدیمی رمزنشده در اولین ورود admin رمز می‌شوند', async () => {
  const now = Date.now();
  const res = db.prepare(
    `INSERT INTO persons (first_name, last_name, title, group_id, extension, direct_line,
       mobile, home_phone, email, address, national_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('قدیمی', 'رمزنشده', '', null, '3999', '', '09000003333', '', '', '', '', '', now, now);
  const id = Number(res.lastInsertRowid);
  assert.equal(db.prepare('SELECT mobile FROM persons WHERE id = ?').get(id).mobile, '09000003333');
  enc.clearDek();
  const c = client();
  await c.login('admin', 'Admin-Test-1');
  assert.ok(db.prepare('SELECT mobile FROM persons WHERE id = ?').get(id).mobile.startsWith('enc1:'));
  const oc = client();
  await oc.login('oper', 'Operator-Test-1');
  assert.equal((await oc.get('/api/persons/' + id)).data.person.mobile, '09000003333');
});

test('تغییر رمز admin: داده با کلید جدید بازرمز می‌شود و خوانا می‌ماند', async () => {
  const before = db.prepare('SELECT mobile FROM persons WHERE last_name = ?').get('کریمی').mobile;
  const c = client();
  await c.login('admin', 'Admin-Test-1');
  const ch = await c.post('/api/me/password', { current: 'Admin-Test-1', new: 'Admin-Test-2' });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  const after = db.prepare('SELECT mobile FROM persons WHERE last_name = ?').get('کریمی').mobile;
  assert.ok(after.startsWith('enc1:'));
  assert.notEqual(after, before);
  const oc = client();
  await oc.login('oper', 'Operator-Test-1');
  assert.equal((await oc.get('/api/persons?q=' + FAKE_MOBILE)).data.items[0].mobile, FAKE_MOBILE);
  // برگرداندن رمز admin تا تست‌های بعدی (در صورت نیاز) با همان رمز کار کنند
  const c2 = client();
  await c2.login('admin', 'Admin-Test-2');
  assert.equal((await c2.post('/api/me/password', { current: 'Admin-Test-2', new: 'Admin-Test-1' })).status, 200);
});

test('قفل: DELETE مخاطب و پشتیبان هم در حالت قفل 401 می‌دهند', async () => {
  enc.clearDek();
  try {
    const oc = client();
    await oc.login('oper', 'Operator-Test-1');
    // در حالت قفل، جستجو هم 401 است، پس شناسه را از دیتابیس می‌خوانیم
    // تا مسیر DELETE مستقیم تست شود
    const pid = db.prepare('SELECT id FROM persons WHERE last_name = ?').get('کریمی').id;
    assert.equal((await oc.del('/api/persons/' + pid)).status, 401);
    assert.equal((await oc.post('/api/backup', {})).status, 401);
    assert.ok(db.prepare('SELECT 1 FROM persons WHERE id = ?').get(pid), 'در حالت قفل نباید چیزی حذف شود');
  } finally {
    enc.setDek(await enc.deriveDek('Admin-Test-1', ctx.salt));
  }
});

test('چرخش CLI در حین اجرا: سرور قفل می‌شود و ورود با رمز جدید بازش می‌کند', async () => {
  const oc = client();
  await oc.login('oper', 'Operator-Test-1');
  assert.equal((await oc.get('/api/persons')).status, 200);
  // شبیه‌سازی دقیق manage.js set-password admin در پروسه جدا: بازرمز
  // با کلید جدید + به‌روزرسانی اثر انگشت، بدون دست‌کاری حافظه سرور
  const { transaction } = require('../lib/db');
  const oldDek = await enc.deriveDek('Admin-Test-1', ctx.salt);
  const newDek = await enc.deriveDek('Admin-CLI-Test-1', ctx.salt);
  const newHash = await auth.hashPassword('Admin-CLI-Test-1');
  transaction(db, () => {
    enc.reencryptAll(db, oldDek, newDek);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = (SELECT id FROM users WHERE username = ?)')
      .run(newHash, 'admin');
    enc.writeDekFingerprint(db, newDek);
  });
  // درخواست بعدی operator باید قفل‌شده برگردد، نه اینکه با کلید قدیمی
  // بخواند یا بنویسد
  const locked = await oc.get('/api/persons');
  assert.equal(locked.status, 401);
  assert.equal(locked.data.code, 'locked');
  // ورود admin با رمز جدید قفل را باز می‌کند و داده خوانا می‌ماند
  const ac = client();
  await ac.login('admin', 'Admin-CLI-Test-1');
  const back = await ac.post('/api/me/password', { current: 'Admin-CLI-Test-1', new: 'Admin-Test-1' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const oc2 = client();
  await oc2.login('oper', 'Operator-Test-1');
  assert.equal((await oc2.get('/api/persons?q=' + FAKE_MOBILE)).data.items[0].mobile, FAKE_MOBILE);
});

test('پشتیبان: دیتابیس دارای مقدار رمزنشده، پشتیبان نمی‌سازد', async () => {
  const now = Date.now();
  const res = db.prepare(
    `INSERT INTO persons (first_name, last_name, title, group_id, extension, direct_line,
       mobile, home_phone, email, address, national_id, note, created_at, updated_at)
     VALUES (?, ?, '', NULL, '', '', ?, '', '', '', '', '', ?, ?)`,
  ).run('پشتیبان', 'رمزنشده', '09000004444', now, now);
  const id = Number(res.lastInsertRowid);
  try {
    assert.throws(() => dir.backupDb(db, path.join(tmp, 'data')), /رمزنشده/);
  } finally {
    db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  }
});

test('مهاجرت: آدرس قدیمی با پیشوند enc1: رمز می‌شود و جستجو خراب نمی‌شود', async () => {
  const now = Date.now();
  const res = db.prepare(
    `INSERT INTO persons (first_name, last_name, title, group_id, extension, direct_line,
       mobile, home_phone, email, address, national_id, note, created_at, updated_at)
     VALUES (?, ?, '', NULL, '3998', '', '09000005555', '', '', ?, '', '', ?, ?)`,
  ).run('پیشوندی', 'قدیمی', 'enc1: reception', now, now);
  const id = Number(res.lastInsertRowid);
  enc.clearDek();
  const c = client();
  await c.login('admin', 'Admin-Test-1');
  const raw = db.prepare('SELECT address FROM persons WHERE id = ?').get(id).address;
  assert.ok(enc.isEncrypted(raw), raw);
  assert.equal(enc.decryptValue(await enc.deriveDek('Admin-Test-1', ctx.salt), raw), 'enc1: reception');
  const oc = client();
  await oc.login('oper', 'Operator-Test-1');
  assert.equal((await oc.get('/api/persons?q=' + encodeURIComponent('پیشوندی'))).data.total, 1);
  assert.equal((await oc.get('/api/persons/' + id)).data.person.address, 'enc1: reception');
});

test('محدودیت تلاش ناموفق ورود: ۱۰ شکست و سپس ۴۲۹', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/login', { username: 'nobody', password: 'x' + i });
  assert.equal(last.status, 429);
});

test('فایل‌های استاتیک: هدرهای امنیتی، بدون داده حساس، بدون پیمایش مسیر', async () => {
  const c = client();
  const index = await c.get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  for (const f of ['/', '/app.js', '/app.css', '/internals-snapshot.js']) {
    const r = await c.get(f);
    assert.equal(r.status, 200, f);
    for (const secret of [FAKE_MOBILE, FAKE_HOME, FAKE_NID, FAKE_EMAIL]) assert.ok(!r.data.includes(secret));
  }
  assert.equal((await c.get('/..%2Fserver.js')).status, 404);
  assert.equal((await c.get('/lib/db.js')).status, 404);
  assert.equal((await c.get('/%2e%2e/server.js')).status, 404);
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.post('/api/me', {})).status, 405);
  // کدی که در صفحه اجرا می‌شود نباید innerHTML داشته باشد (XSS)
  assert.ok(!/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/.test((await c.get('/app.js')).data));
});

