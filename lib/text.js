'use strict';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** تبدیل ارقام فارسی و عربی به لاتین */
function toLatinDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (ch) => {
    const i = FA_DIGITS.indexOf(ch);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(ch));
  });
}

function unifyLetters(s) {
  return s.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
}

/** پاک‌سازی متن ورودی برای ذخیره: ی/ک یکسان، حذف کاراکترهای کنترلی، فاصله‌های اضافه */
function cleanText(value) {
  if (value == null) return '';
  return unifyLetters(String(value))
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** کلید جستجو: ارقام لاتین، ی/ک یکسان، بدون نیم‌فاصله/اعراب/کشیده، حروف کوچک */
function searchKey(value) {
  return unifyLetters(toLatinDigits(value))
    .replace(/[‌‍‎‏ً-ٟـ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { toLatinDigits, cleanText, searchKey };
