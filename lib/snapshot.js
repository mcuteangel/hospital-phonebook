'use strict';

const fs = require('node:fs');
const path = require('node:path');

const collator = new Intl.Collator('fa');

/**
 * فایل استاتیک «internals-snapshot.js» را می‌نویسد تا صفحه بدون سرور (file://)
 * هم بتواند فهرست داخلی‌ها را نشان دهد.
 * قانون طلایی: فقط داخلی‌های بیمارستان در این فایل می‌آید؛ هیچ داده شخصی/حساسی نه.
 */
function writeSnapshot(db, publicDir) {
  try {
    const items = db
      .prepare('SELECT department, number, note FROM internals')
      .all()
      .map((r) => ({ department: r.department, number: r.number, note: r.note }))
      .sort((a, b) => collator.compare(a.department, b.department) || collator.compare(a.number, b.number));
    const payload = { generated: new Date().toISOString(), items };
    const file = path.join(publicDir, 'internals-snapshot.js');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, `window.INTERNALS_SNAPSHOT = ${JSON.stringify(payload)};\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn('نوشتن internals-snapshot.js ممکن نشد:', err.message);
    return false;
  }
}

module.exports = { writeSnapshot };
