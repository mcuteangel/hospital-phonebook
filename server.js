'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, requireNode22 } = require('./lib/config');
const { openDb } = require('./lib/db');
const auth = require('./lib/auth');
const dir = require('./lib/directory');
const { writeSnapshot } = require('./lib/snapshot');
const { HttpError } = require('./lib/errors');

const COOKIE_NAME = 'sid';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        reject(new HttpError(413, 'حجم درخواست بیش از حد مجاز است'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'نوع محتوا باید JSON باشد');
  const buf = await readBody(req, 1_000_000);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON نامعتبر است');
  }
}

async function readCsvText(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('text/csv') && !ct.startsWith('text/plain')) throw new HttpError(415, 'نوع محتوا باید text/csv باشد');
  return (await readBody(req, 5_000_000)).toString('utf8');
}

function setSecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

function intParam(value, label) {
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${label} نامعتبر است`);
  return Number(value);
}

function createApp({ db, publicDir, dataDir }) {
  const limiter = auth.createLimiter();
  const routes = [];
  const route = (method, pattern, access, handler) =>
    routes.push({ method, re: new RegExp(`^${pattern}$`), access, handler });

  // ── احراز هویت ──
  route('GET', '/api/me', 'public', ({ res, user }) =>
    send(res, 200, { user: user ? { username: user.username, role: user.role, mustChangePassword: user.mustChangePassword } : null }),
  );

  route('POST', '/api/login', 'public', async ({ req, res }) => {
    const ip = req.socket.remoteAddress || '?';
    if (limiter.blocked(ip)) throw new HttpError(429, 'تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید');
    const b = await readJson(req);
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase().slice(0, 64) : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
    const row = db.prepare('SELECT id, username, role, password_hash, must_change_password FROM users WHERE username = ?').get(username);
    const ok = await auth.verifyPassword(password, row ? row.password_hash : null);
    if (!row || !ok) {
      limiter.fail(ip);
      throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است');
    }
    limiter.reset(ip);
    const token = auth.createSession(db, row.id);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(auth.SESSION_TTL_MS / 1000)));
    send(res, 200, { user: { username: row.username, role: row.role, mustChangePassword: row.must_change_password === 1 } });
  });

  route('POST', '/api/logout', 'user', ({ res, user }) => {
    auth.destroySession(db, user.tokenHash);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    send(res, 200, { ok: true });
  });

  route('POST', '/api/me/password', 'user', async ({ req, res, user }) => {
    const b = await readJson(req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    const ok = await auth.verifyPassword(typeof b.current === 'string' ? b.current : '', row.password_hash);
    if (!ok) throw new HttpError(400, 'رمز فعلی اشتباه است');
    await auth.setPassword(db, user.id, b.new);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, user.tokenHash);
    send(res, 200, { ok: true });
  });

  // ── داخلی‌های بیمارستان (عمومی برای خواندن) ──
  route('GET', '/api/internals', 'public', ({ res, query }) =>
    send(res, 200, { items: dir.listInternals(db, query.get('q') || '') }),
  );
  route('POST', '/api/internals', 'operator', async ({ req, res }) => {
    const id = dir.createInternal(db, await readJson(req));
    writeSnapshot(db, publicDir);
    send(res, 201, { id });
  });
  route('PUT', '/api/internals/(?<id>\\d+)', 'operator', async ({ req, res, params }) => {
    dir.updateInternal(db, intParam(params.id, 'شناسه'), await readJson(req));
    writeSnapshot(db, publicDir);
    send(res, 200, { ok: true });
  });
  route('DELETE', '/api/internals/(?<id>\\d+)', 'operator', ({ res, params }) => {
    dir.deleteInternal(db, intParam(params.id, 'شناسه'));
    writeSnapshot(db, publicDir);
    send(res, 200, { ok: true });
  });

  // ── گروه‌ها ──
  route('GET', '/api/groups', 'user', ({ res }) => send(res, 200, { items: dir.listGroups(db) }));
  route('POST', '/api/groups', 'operator', async ({ req, res }) =>
    send(res, 201, { id: dir.createGroup(db, await readJson(req)) }),
  );
  route('PUT', '/api/groups/(?<id>\\d+)', 'operator', async ({ req, res, params }) => {
    dir.updateGroup(db, intParam(params.id, 'شناسه'), await readJson(req));
    send(res, 200, { ok: true });
  });
  route('DELETE', '/api/groups/(?<id>\\d+)', 'operator', ({ res, params }) => {
    dir.deleteGroup(db, intParam(params.id, 'شناسه'));
    send(res, 200, { ok: true });
  });

  // ── مخاطبین ──
  route('GET', '/api/persons', 'user', ({ res, user, query }) => {
    const g = query.get('group');
    const lim = query.get('limit');
    const result = dir.searchPersons(db, user, {
      q: (query.get('q') || '').slice(0, 100),
      group: g ? intParam(g, 'گروه') : null,
      type: query.get('type') || '',
      fav: query.get('fav') === '1',
      limit: lim ? Math.min(Math.max(intParam(lim, 'limit'), 1), 1000) : 500,
    });
    send(res, 200, result);
  });
  route('POST', '/api/persons', 'operator', async ({ req, res, user }) => {
    const id = dir.createPerson(db, await readJson(req));
    send(res, 201, { person: dir.getPerson(db, user, id) });
  });
  route('GET', '/api/persons/(?<id>\\d+)', 'user', ({ res, user, params }) =>
    send(res, 200, { person: dir.getPerson(db, user, intParam(params.id, 'شناسه')) }),
  );
  route('PUT', '/api/persons/(?<id>\\d+)', 'operator', async ({ req, res, user, params }) => {
    const id = intParam(params.id, 'شناسه');
    dir.updatePerson(db, id, await readJson(req));
    send(res, 200, { person: dir.getPerson(db, user, id) });
  });
  route('DELETE', '/api/persons/(?<id>\\d+)', 'operator', ({ res, params }) => {
    dir.deletePerson(db, intParam(params.id, 'شناسه'));
    send(res, 200, { ok: true });
  });
  route('PUT', '/api/persons/(?<id>\\d+)/favorite', 'user', ({ res, user, params }) => {
    dir.setFavorite(db, user.id, intParam(params.id, 'شناسه'), true);
    send(res, 200, { favorite: true });
  });
  route('DELETE', '/api/persons/(?<id>\\d+)/favorite', 'user', ({ res, user, params }) => {
    dir.setFavorite(db, user.id, intParam(params.id, 'شناسه'), false);
    send(res, 200, { favorite: false });
  });
  route('POST', '/api/persons/(?<id>\\d+)/touch', 'user', ({ res, user, params }) => {
    dir.touchRecent(db, user.id, intParam(params.id, 'شناسه'));
    send(res, 200, { ok: true });
  });
  route('GET', '/api/recents', 'user', ({ res, user }) => send(res, 200, { items: dir.listRecents(db, user) }));

  // ── آمار، CSV، پشتیبان ──
  route('GET', '/api/stats', 'user', ({ res, user }) => send(res, 200, dir.stats(db, user)));

  route('GET', '/api/export.csv', 'operator', ({ res }) => {
    const body = Buffer.from(dir.exportCsv(db), 'utf8');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contacts-${stamp}.csv"`,
      'Content-Length': body.length,
    });
    res.end(body);
  });
  route('POST', '/api/import', 'operator', async ({ req, res }) =>
    send(res, 200, dir.importCsv(db, await readCsvText(req))),
  );
  route('POST', '/api/backup', 'operator', ({ res }) => send(res, 201, { file: dir.backupDb(db, dataDir) }));

  // ── فایل‌های استاتیک (فقط پوشه public، تخت و بدون زیرپوشه) ──
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'روش مجاز نیست');
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new HttpError(404, 'یافت نشد');
    let data;
    try {
      data = fs.readFileSync(path.join(publicDir, name));
    } catch {
      throw new HttpError(404, 'یافت نشد');
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (origin === 'null' || host !== req.headers.host) throw new HttpError(403, 'درخواست از مبدأ نامعتبر');
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    res.setHeader('Cache-Control', 'no-store');
    let pathMatched = false;
    let found = null;
    for (const rt of routes) {
      const m = rt.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (rt.method === req.method) {
        found = { rt, params: m.groups || {} };
        break;
      }
    }
    if (!found) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'روش مجاز نیست' : 'یافت نشد');

    if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);

    const cookies = auth.parseCookies(req.headers.cookie);
    const user = auth.findSession(db, cookies[COOKIE_NAME]);
    if (found.rt.access !== 'public' && !user) throw new HttpError(401, 'ابتدا وارد شوید', 'auth');
    if (found.rt.access === 'operator' && user.role !== 'operator') {
      throw new HttpError(403, 'دسترسی کافی ندارید', 'forbidden');
    }
    // تا وقتی رمز اجباری عوض نشده، فقط خروج و تغییر رمز مجازند
    if (user && user.mustChangePassword && (found.rt.access === 'user' || found.rt.access === 'operator')
        && pathname !== '/api/logout' && pathname !== '/api/me/password') {
      throw new HttpError(403, 'ابتدا رمز عبور خود را تغییر دهید', 'password-change-required');
    }
    const url = new URL(req.url, 'http://localhost');
    await found.rt.handler({ req, res, user, params: found.params, query: url.searchParams });
  }

  function fail(res, err) {
    if (err instanceof HttpError) {
      if (res.headersSent) return res.end();
      if (err.status === 413) res.setHeader('Connection', 'close');
      return send(res, err.status, { error: err.message, code: err.code });
    }
    console.error(err);
    if (res.headersSent) return res.end();
    send(res, 500, { error: 'خطای داخلی سرور' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, err));
  });
  const purgeTimer = setInterval(() => auth.purgeExpired(db), 60 * 60 * 1000);
  purgeTimer.unref();
  server.on('close', () => clearInterval(purgeTimer));
  return server;
}

async function main() {
  requireNode22();
  const cfg = loadConfig();
  const db = openDb(cfg.dbFile);
  auth.purgeExpired(db);

  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const password = auth.generatePassword();
    await auth.createUser(db, 'admin', 'operator', password, { mustChangePassword: true });
    console.log('\n──────── اولین اجرا ────────');
    console.log('کاربر admin ساخته شد (این رمز فقط همین یک بار نمایش داده می‌شود):');
    console.log(`  نام کاربری: admin`);
    console.log(`  رمز عبور:   ${password}`);
    console.log('در اولین ورود، تغییر رمز عبور اجباری است؛ تا وقتی رمز عوض نشود، بقیه بخش‌ها باز نمی‌شوند.');
    console.log('────────────────────────────\n');
  }

  writeSnapshot(db, cfg.publicDir);
  const server = createApp({ db, publicDir: cfg.publicDir, dataDir: cfg.dataDir });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`پورت ${cfg.port} در حال استفاده است. با PORT=<عدد> پورت دیگری بدهید.`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`دفتر تلفن بیمارستان: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`دیتابیس: ${cfg.dbFile}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp };
