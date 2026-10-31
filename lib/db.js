'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2563eb'
);

CREATE TABLE IF NOT EXISTS persons (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT NOT NULL DEFAULT '',
  last_name   TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  group_id    INTEGER REFERENCES groups(id) ON DELETE RESTRICT,
  extension   TEXT NOT NULL DEFAULT '',
  direct_line TEXT NOT NULL DEFAULT '',
  mobile      TEXT NOT NULL DEFAULT '',
  home_phone  TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  national_id TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS persons_group ON persons(group_id);

CREATE TABLE IF NOT EXISTS internals (
  id         INTEGER PRIMARY KEY,
  department TEXT NOT NULL,
  number     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operator','viewer')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, person_id)
);

CREATE TABLE IF NOT EXISTS recents (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  used_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, person_id)
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // journal پیش‌فرض (DELETE) عمداً: کپی ساده فایل برای پشتیبان‌گیری امن‌تر است
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

/** اجرای fn (همگام) داخل یک تراکنش؛ تو در تو نباید صدا زده شود */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = { openDb, transaction };
