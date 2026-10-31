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
const { openDb } = require('./lib/db');
const auth = require('./lib/auth');
const dir = require('./lib/directory');

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
      if (!a) throw new Error('استفاده: node manage.js set-password <username>');
      const row = db.prepare('SELECT id FROM users WHERE username = ?').get(a.toLowerCase());
      if (!row) throw new Error('کاربر پیدا نشد');
      const password = auth.generatePassword();
      await auth.setPassword(db, row.id, password);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
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
