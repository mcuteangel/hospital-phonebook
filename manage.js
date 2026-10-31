'use strict';

/**
 * مدیریت کاربران از خط فرمان:
 *   node manage.js list-users
 *   node manage.js add-user <username> <operator|viewer>
 *   node manage.js set-password <username>
 *   node manage.js backup
 * رمز به‌صورت تصادفی ساخته و یک بار چاپ می‌شود (رمز در تاریخچه ترمینال نمی‌ماند).
 */

const { loadConfig, requireNode22 } = require('./lib/config');
const { openDb, transaction } = require('./lib/db');
const auth = require('./lib/auth');
const dir = require('./lib/directory');
const enc = require('./lib/crypto');

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
      if (!a) throw new Error('استفاده: node manage.js set-password <username> [رمز-فعلی]');
      const row = db.prepare('SELECT id, role, password_hash FROM users WHERE username = ?').get(a.toLowerCase());
      if (!row) throw new Error('کاربر پیدا نشد');
      const password = auth.generatePassword();
      if (a.toLowerCase() === 'admin' && row.role === 'operator') {
        // کلید رمزنگاری داده‌ها از رمز admin ساخته می‌شود؛ بدون رمز فعلی، بازرمز ممکن نیست
        if (!b) throw new Error('برای admin رمز فعلی لازم است: node manage.js set-password admin <رمز-فعلی>');
        const okOld = await auth.verifyPassword(b, row.password_hash);
        if (!okOld) throw new Error('رمز فعلی اشتباه است');
        const salt = enc.getOrCreateSalt(db);
        const oldDek = await enc.deriveDek(b, salt);
        const newDek = await enc.deriveDek(password, salt);
        const newHash = await auth.hashPassword(password);
        transaction(db, () => {
          enc.reencryptAll(db, oldDek, newDek);
          db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(newHash, row.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
        });
      } else {
        await auth.setPassword(db, row.id, password);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      }
      console.log(`رمز جدید «${a}»: ${password}`);
      break;
    }
    case 'backup': {
      console.log(`پشتیبان ساخته شد: ${cfg.dataDir}/backups/${dir.backupDb(db, cfg.dataDir)}`);
      break;
    }
    default:
      console.log('دستورها: list-users | add-user <username> <operator|viewer> | set-password <username> | backup');
  }
  db.close();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
