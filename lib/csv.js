'use strict';

/** تشخیص جداکننده از سطر اول (کاما، نقطه‌ویرگول یا تب؛ اکسل فارسی اغلب ; می‌گذارد) */
function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of first) if (ch in counts) counts[ch]++;
  let best = ',';
  for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d;
  return best;
}

function parseCsv(input) {
  const text = String(input).replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** جلوگیری از اجرای فرمول در اکسل (CSV injection) */
function safeCell(value) {
  const s = value == null ? '' : String(value);
  if (/^[=@\t\r]/.test(s) || /^[+-](?!\d)/.test(s)) return "'" + s;
  return s;
}

function quote(s) {
  return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function stringifyCsv(rows) {
  const body = rows.map((r) => r.map((c) => quote(safeCell(c))).join(',')).join('\r\n');
  return '﻿' + body + '\r\n';
}

module.exports = { parseCsv, stringifyCsv, safeCell };
