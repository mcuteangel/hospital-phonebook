'use strict';

const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');

function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`این برنامه به Node 22 یا بالاتر نیاز دارد (نسخه فعلی: ${process.versions.node}).`);
    process.exit(1);
  }
}

/**
 * پیکربندی از متغیرهای محیطی:
 *   PORT      پیش‌فرض 3001
 *   HOST      پیش‌فرض 127.0.0.1 (برای شبکه داخلی: 0.0.0.0)
 *   DATA_DIR  پیش‌فرض ../data (کنار پوشه برنامه، نه داخل آن)
 */
function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, '..', 'data'));
  return {
    appDir: APP_DIR,
    publicDir: path.join(APP_DIR, 'public'),
    dataDir,
    dbFile: path.join(dataDir, 'directory.db'),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3001),
  };
}

module.exports = { loadConfig, requireNode22 };
