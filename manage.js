'use strict';

/**
 * مدیریت کاربران از خط فرمان:
 *   node manage.js list-users
 *   node manage.js add-user <username> <operator|viewer>
 *   node manage.js set-password <username>
 *   node manage.js backup
 *   node manage.js audit-backups   # وضعیت رمزنگاری پشتیبان‌های .db موجود
 * رمز به‌صورت تصادفی ساخته و یک بار چاپ می‌شود (رمز در تاریخچه ترمینال نمی‌ماند).
 * برای admin، رمز فعلی هرگز به‌عنوان آرگومان خط فرمان پذیرفته نمی‌شود
 * (در تاریخچه شل و فهرست پردازه‌ها دیده می‌شد)؛ در عوض با پرامپت
 * بدون echo از ترمینال پرسیده می‌شود. چرخش رمز admin در حین اجرای
 * سرور امن است: اثر انگشت کلید تازه ثبت می‌شود و سرورِ در حال اجرا
 * در اولین درخواست operator خودش را قفل می‌کند تا admin با رمز جدید
 * وارد شود (نوشتن با کلید قدیمی ممکن نیست).
 */

const { loadConfig, requireNode22 } = require('./lib/config');
const { openDb, transaction } = require('./lib/db');
const auth = require('./lib/auth');
const dir = require('./lib/directory');
const enc = require('./lib/crypto');

/**
 * پرسیدن رمز بدون echo در ترمینال (بدون دیپندنسی). در ورودی غیرترمینال
 * (لوله) خط خوانده می‌شود تا در اسکریپت هم کار کند؛ رمز هرگز در
 * process.argv قرار نمی‌گیرد.
 */
function promptPassword(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    if (!process.stdin.isTTY) {
      const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pw = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        process.stdout.write('\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        resolve(pw);
      } else if (ch === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        reject(new Error('لغو شد'));
      } else if (ch === '\u007f' || ch === '\b') {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** تغییر رمز یک کاربر؛ برای admin همراه با بازرمز همه ستون‌های حساس */
async function cmdSetPassword(db, username, argvPassword) {
  if (!username) throw new Error('استفاده: node manage.js set-password <username>');
  const row = db.prepare('SELECT id, role, password_hash FROM users WHERE username = ?').get(username.toLowerCase());
  if (!row) throw new Error('کاربر پیدا نشد');
  const password = auth.generatePassword();
  if (username.toLowerCase() === 'admin' && row.role === 'operator') {
    // کلید رمزنگاری داده‌ها از رمز admin ساخته می‌شود؛ بدون رمز فعلی، بازرمز ممکن نیست.
    // رمز فعلی عمداً از آرگومان خوانده نمی‌شود (نشت در تاریخچه/فهرست
    // پردازه‌ها)؛ با پرامپت بدون echo پرسیده می‌شود.
    if (argvPassword) throw new Error('رمز فعلی را در خط فرمان ندهید؛ بدون آرگومان اجرا کنید تا با پرامپت امن پرسیده شود');
    const current = await promptPassword('رمز فعلی admin: ');
    const okOld = await auth.verifyPassword(current, row.password_hash);
    if (!okOld) throw new Error('رمز فعلی اشتباه است');
    const salt = enc.getOrCreateSalt(db);
    const oldDek = await enc.deriveDek(current, salt);
    const newDek = await enc.deriveDek(password, salt);
    const newHash = await auth.hashPassword(password);
    transaction(db, () => {
      enc.reencryptAll(db, oldDek, newDek);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(newHash, row.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      // اثر انگشت کلید تازه: سرورِ در حال اجرا در اولین درخواست
      // operator متوجه عدم تطابق می‌شود و خودش را قفل می‌کند.
      enc.writeDekFingerprint(db, newDek);
    });
  } else {
    await auth.setPassword(db, row.id, password);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  }
  console.log(`رمز جدید «${username}»: ${password}`);
  if (username.toLowerCase() === 'admin' && row.role === 'operator') {
    console.log('توجه: اگر سرور در حال اجراست، در اولین درخواست operator خودش را قفل می‌کند؛ admin باید با رمز جدید وارد شود تا داده حساس دوباره در دسترس شود.');
  }
}

async function main() {
  requireNode22();
  const cfg = loadConfig();
  const db = openDb(cfg.dbFile);
  const [cmd, a, b] = process.argv.slice(2);

  switch (cmd) {
    case 'list-users': {
      for (const u of db.prepare('SELECT username, role FROM users ORDER BY username').all()) {
        console.log(`${u.username}\t${u.role}`);
      }
      break;
    }
    case 'add-user': {
      if (!a || !b) throw new Error('استفاده: node manage.js add-user <username> <operator|viewer>');
      const password = auth.generatePassword();
      const name = await auth.createUser(db, a, b, password);
      console.log(`کاربر «${name}» (${b}) ساخته شد.\nرمز عبور: ${password}`);
      break;
    }
    case 'set-password': {
      await cmdSetPassword(db, a, b);
      break;
    }
    case 'backup': {
      console.log(`پشتیبان ساخته شد: ${cfg.dataDir}/backups/${dir.backupDb(db, cfg.dataDir)}`);
      break;
    }
    case 'audit-backups': {
      const results = dir.auditBackups(cfg.dataDir);
      if (results.length === 0) {
        console.log('پشتیبانی در backups/ نیست.');
        break;
      }
      for (const r of results) {
        if (r.error) console.log(`${r.file}: بررسی نشد (${r.error})`);
        else if (r.plaintext) console.log(`${r.file}: رمزنشده — حذف یا در جای امن نگه دارید`);
        else console.log(`${r.file}: رمز شده`);
      }
      break;
    }
    default:
      console.log('دستورها: list-users | add-user <username> <operator|viewer> | set-password <username> | backup | audit-backups');
  }
  db.close();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
