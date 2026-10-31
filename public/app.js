'use strict';
(function () {
  const state = { user: null, groups: [], tab: 'internals', q: '', group: '', type: '', offline: false };
  let forcedPasswordOpen = false;
  const $ = (sel) => document.querySelector(sel);
  const fa = (n) => Number(n).toLocaleString('fa-IR');
  const isOp = () => state.user && state.user.role === 'operator';

  // ───────── ابزارهای DOM (همیشه textContent؛ هرگز innerHTML با داده) ─────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#64748b');
  function chip(name, color) {
    const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
    dot.style.backgroundColor = safeColor(color);
    return h('span', { class: 'chip' }, dot, name);
  }
  const num = (v) => h('span', { class: 'num' }, v);
  const fullName = (p) => `${p.first_name} ${p.last_name}`.trim();

  // مشابه نرمال‌سازی سمت سرور (برای جستجوی آفلاین)
  function toLatin(s) {
    return String(s ?? '').replace(/[۰-۹٠-٩]/g, (ch) => {
      const i = '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch);
      return String(i >= 0 ? i : '٠١٢٣٤٥٦٧٨٩'.indexOf(ch));
    });
  }
  function skey(s) {
    return toLatin(s)
      .replace(/[يى]/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[‌‍‎‏ً-ٟـ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      if (typeof body === 'string') {
        init.headers['Content-Type'] = 'text/csv; charset=utf-8';
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw Object.assign(new Error('اتصال به سرور برقرار نیست'), { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && data.code !== 'locked' && state.user) {
        state.user = null;
        state.tab = 'internals';
        renderAll();
        toast('نشست شما پایان یافت؛ دوباره وارد شوید');
      }
      if (data.code === 'password-change-required' && !forcedPasswordOpen) passwordDialog(true);
      throw Object.assign(new Error(data.error || 'خطای ناشناخته'), { status: res.status });
    }
    return data;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  // ───────── دیالوگ ─────────
  const dlg = $('#dlg');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  function openDialog(...content) {
    dlg.replaceChildren(h('div', { class: 'dlg-body' }, content));
    if (!dlg.open) dlg.showModal();
  }
  const closeDialog = () => dlg.open && dlg.close();

  // ───────── سربرگ، تب‌ها، نوار ابزار ─────────
  const ROLE_FA = { operator: 'اپراتور', viewer: 'مشاهده‌گر' };

  function renderUserbar() {
    const bar = $('#userbar');
    bar.replaceChildren();
    if (state.offline) return;
    if (state.user) {
      bar.append(
        h('span', null, `${state.user.username} (${ROLE_FA[state.user.role] || state.user.role})`),
        h('button', { class: 'btn small', onclick: () => passwordDialog(false) }, 'تغییر رمز'),
        h('button', { class: 'btn small', onclick: logout }, 'خروج'),
      );
    } else {
      bar.append(h('button', { class: 'btn primary', onclick: loginDialog }, 'ورود'));
    }
  }

  function availableTabs() {
    if (state.offline || !state.user) return [['internals', 'داخلی‌های بیمارستان']];
    const tabs = [
      ['contacts', 'مخاطبین'],
      ['internals', 'داخلی‌های بیمارستان'],
      ['favorites', 'علاقه‌مندی‌ها'],
      ['recents', 'اخیرها'],
      ['stats', 'آمار'],
    ];
    if (isOp()) tabs.push(['admin', 'مدیریت']);
    return tabs;
  }

  function renderTabs() {
    const nav = $('#tabs');
    nav.replaceChildren(
      ...availableTabs().map(([id, label]) =>
        h('button', { class: 'tab', 'aria-current': state.tab === id ? 'page' : null, onclick: () => switchTab(id) }, label),
      ),
    );
  }

  const searchInput = h('input', {
    type: 'search', id: 'q', autocomplete: 'off', 'aria-label': 'جستجو',
    placeholder: 'جستجو: نام، نام خانوادگی، شماره یا کد داخلی…  (کلید /)',
  });
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { state.q = searchInput.value; refresh(); }, 150);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      state.q = '';
      refresh();
    }
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === '/' && !dlg.open && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  function renderToolbar() {
    const bar = $('#toolbar');
    bar.replaceChildren();
    const searchable = ['contacts', 'internals', 'favorites'].includes(state.tab);
    if (!searchable) return;
    bar.append(searchInput);
    if (state.tab === 'contacts') {
      const gsel = h('select', { 'aria-label': 'گروه', onchange: (e) => { state.group = e.target.value; refresh(); } },
        h('option', { value: '' }, 'همه گروه‌ها'),
        state.groups.map((g) => h('option', { value: String(g.id), selected: String(g.id) === state.group }, g.name)),
      );
      const types = [['', 'همه شماره‌ها'], ['internal', 'دارای کد داخلی'], ['direct', 'دارای خط مستقیم']];
      if (isOp()) types.push(['mobile', 'دارای موبایل'], ['home', 'دارای تلفن منزل']);
      const tsel = h('select', { 'aria-label': 'نوع شماره', onchange: (e) => { state.type = e.target.value; refresh(); } },
        types.map(([v, l]) => h('option', { value: v, selected: v === state.type }, l)),
      );
      bar.append(gsel, tsel);
      if (isOp()) bar.append(h('button', { class: 'btn primary', onclick: () => personForm(null) }, '＋ مخاطب جدید'));
    }
    if (state.tab === 'internals' && isOp()) {
      bar.append(h('button', { class: 'btn primary', onclick: () => internalForm(null) }, '＋ داخلی جدید'));
    }
  }

  function renderBanner() {
    const b = $('#banner');
    if (state.offline) {
      const snap = window.INTERNALS_SNAPSHOT;
      const when = snap && snap.generated ? new Date(snap.generated).toLocaleString('fa-IR') : 'نامشخص';
      b.textContent = `حالت آفلاین: سرور در دسترس نیست و فقط فهرست داخلی‌های بیمارستان نمایش داده می‌شود (آخرین به‌روزرسانی: ${when}).`;
      b.hidden = false;
    } else if (!state.user) {
      b.textContent = 'برای دسترسی به مخاطبین وارد شوید. فهرست داخلی‌های بیمارستان بدون ورود در دسترس است.';
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  async function switchTab(id) {
    state.tab = id;
    if (id === 'contacts' && state.user) {
      // گروه‌ها ممکن است در تب مدیریت یا با ورود CSV تغییر کرده باشند
      try { state.groups = (await api('/api/groups')).items; } catch { /* ignore */ }
    }
    renderTabs();
    renderToolbar();
    refresh();
  }

  function renderAll() {
    renderUserbar();
    renderBanner();
    if (!availableTabs().some(([id]) => id === state.tab)) state.tab = availableTabs()[0][0];
    renderTabs();
    renderToolbar();
    refresh();
  }

  // ───────── نمای‌ها ─────────
  const view = $('#view');
  let seq = 0;

  function showError(err) {
    view.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
  }

  function refresh() {
    const my = ++seq;
    const run = {
      contacts: () => viewPersons('contacts', my),
      favorites: () => viewPersons('favorites', my),
      recents: () => viewRecents(my),
      internals: () => viewInternals(my),
      stats: () => viewStats(my),
      admin: () => viewAdmin(my),
    }[state.tab];
    return run().catch((err) => { if (my === seq) showError(err); });
  }

  function numCell(p, field, label) {
    const v = p[field];
    if (!v) return h('td', { class: 'muted' }, '—');
    return h('td', null,
      h('button', {
        class: 'num-btn', title: `کپی ${label}`,
        onclick: async () => {
          const ok = await copyText(v);
          toast(ok ? `${label} کپی شد: ${v}` : 'کپی ممکن نشد');
          api(`/api/persons/${p.id}/touch`, { method: 'POST' }).catch(() => {});
        },
      }, num(v)),
    );
  }

  function favButton(p) {
    const btn = h('button', { class: 'fav', 'aria-pressed': String(p.favorite), 'aria-label': `علاقه‌مندی: ${fullName(p)}` }, p.favorite ? '★' : '☆');
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/persons/${p.id}/favorite`, { method: p.favorite ? 'DELETE' : 'PUT' });
        p.favorite = !p.favorite;
        btn.textContent = p.favorite ? '★' : '☆';
        btn.setAttribute('aria-pressed', String(p.favorite));
        if (state.tab === 'favorites' && !p.favorite) refresh();
      } catch (err) { toast(err.message); }
    });
    return btn;
  }

  function personTable(items) {
    const op = isOp();
    const head = ['نام', 'گروه', 'کد داخلی', 'خط مستقیم'];
    if (op) head.push('موبایل', 'تلفن منزل');
    head.push('');
    return h('div', { class: 'tablewrap' },
      h('table', null,
        h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, items.map((p) =>
          h('tr', null,
            h('td', null,
              h('button', { class: 'link', onclick: () => openPerson(p.id) }, fullName(p)),
              p.title ? h('div', { class: 'sub' }, p.title) : null,
              p.note ? h('div', { class: 'note' }, p.note) : null),
            h('td', null, p.group_name ? chip(p.group_name, p.group_color) : '—'),
            numCell(p, 'extension', 'کد داخلی'),
            numCell(p, 'direct_line', 'خط مستقیم'),
            op ? numCell(p, 'mobile', 'موبایل') : null,
            op ? numCell(p, 'home_phone', 'تلفن منزل') : null,
            h('td', null, favButton(p)),
          )),
        ),
      ),
    );
  }

  async function viewPersons(kind, my) {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (kind === 'contacts') {
      if (state.group) params.set('group', state.group);
      if (state.type) params.set('type', state.type);
    } else {
      params.set('fav', '1');
    }
    const data = await api(`/api/persons?${params}`);
    if (my !== seq) return;
    if (!data.items.length) {
      view.replaceChildren(h('p', { class: 'empty' }, kind === 'favorites' && !state.q ? 'هنوز علاقه‌مندی‌ای ندارید. با ☆ کنار هر مخاطب اضافه کنید.' : 'موردی پیدا نشد.'));
      return;
    }
    const more = data.total > data.items.length ? ` (${fa(data.items.length)} مورد اول نمایش داده شد؛ جستجو را دقیق‌تر کنید)` : '';
    view.replaceChildren(h('p', { class: 'count' }, `${fa(data.total)} مورد${more}`), personTable(data.items));
  }

  async function viewRecents(my) {
    const data = await api('/api/recents');
    if (my !== seq) return;
    view.replaceChildren(
      data.items.length
        ? personTable(data.items)
        : h('p', { class: 'empty' }, 'هنوز شماره‌ای کپی نشده است. با کلیک روی هر شماره، آن مخاطب اینجا ثبت می‌شود.'),
    );
  }

  async function viewInternals(my) {
    let items;
    if (state.offline) {
      const all = (window.INTERNALS_SNAPSHOT && window.INTERNALS_SNAPSHOT.items) || [];
      const tokens = skey(state.q).split(' ').filter(Boolean);
      items = all.filter((r) => {
        const hay = skey(`${r.department} ${r.number} ${r.note}`);
        return tokens.every((t) => hay.includes(t));
      });
    } else {
      items = (await api(`/api/internals?q=${encodeURIComponent(state.q)}`)).items;
    }
    if (my !== seq) return;
    if (!items.length) {
      view.replaceChildren(h('p', { class: 'empty' }, 'موردی پیدا نشد.'));
      return;
    }
    const op = isOp() && !state.offline;
    view.replaceChildren(
      h('p', { class: 'count' }, `${fa(items.length)} مورد`),
      h('div', { class: 'tablewrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['بخش', 'شماره داخلی', 'توضیح', op ? '' : null].filter((x) => x !== null).map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, items.map((r) =>
            h('tr', null,
              h('td', null, r.department),
              h('td', null, h('button', {
                class: 'num-btn', title: 'کپی شماره',
                onclick: async () => toast((await copyText(r.number)) ? `کپی شد: ${r.number}` : 'کپی ممکن نشد'),
              }, num(r.number))),
              h('td', { class: 'muted' }, r.note || '—'),
              op ? h('td', null, h('button', { class: 'btn small', onclick: () => internalForm(r) }, 'ویرایش')) : null,
            )),
          ),
        ),
      ),
    );
  }

  function barRow(label, count, max, color) {
    const fill = h('div', { class: 'bar-fill' });
    fill.style.width = `${max ? Math.round((count / max) * 100) : 0}%`;
    if (color) fill.style.backgroundColor = safeColor(color);
    return h('div', { class: 'bar-row' }, h('span', null, label), h('div', { class: 'bar-track' }, fill), h('span', { class: 'num' }, fa(count)));
  }

  async function viewStats(my) {
    const s = await api('/api/stats');
    if (my !== seq) return;
    const cards = [['کل مخاطبین', s.total], ['تعداد گروه‌ها', s.groups]];
    if (s.incomplete_count != null) cards.push(['رکورد ناقص (بدون شماره)', s.incomplete_count]);
    const maxGroup = Math.max(1, ...s.per_group.map((g) => g.count));
    const letters = (list) => {
      const max = Math.max(1, ...list.map((x) => x.count));
      return list.length ? list.map((x) => barRow(x.letter, x.count, max)) : h('p', { class: 'muted' }, 'داده‌ای نیست');
    };
    view.replaceChildren(
      h('div', { class: 'cards' }, cards.map(([l, v]) => h('div', { class: 'card' }, h('b', null, fa(v)), l))),
      h('div', { class: 'panel' }, h('h2', null, 'تعداد مخاطب در هر گروه'), s.per_group.map((g) => barRow(g.name, g.count, maxGroup, g.color))),
      h('div', { class: 'two-col' },
        h('div', { class: 'panel' }, h('h2', null, 'حرف اول نام'), letters(s.first_letters)),
        h('div', { class: 'panel' }, h('h2', null, 'حرف اول نام خانوادگی'), letters(s.last_letters)),
      ),
      s.incomplete && s.incomplete.length
        ? h('div', { class: 'panel' }, h('h2', null, 'رکوردهای ناقص (بدون هیچ شماره)'),
            h('ul', null, s.incomplete.map((p) => h('li', null, h('button', { class: 'link', onclick: () => openPerson(p.id) }, p.name)))))
        : null,
    );
  }

  async function viewAdmin(my) {
    const groups = (await api('/api/groups')).items;
    if (my !== seq) return;
    state.groups = groups;

    const groupRow = (g) => {
      const name = h('input', { type: 'text', value: g ? g.name : '', maxlength: '40', 'aria-label': 'نام گروه', placeholder: 'نام گروه جدید' });
      const color = h('input', { type: 'color', value: g ? safeColor(g.color) : '#2563eb', 'aria-label': 'رنگ گروه' });
      const save = h('button', { class: 'btn small primary', onclick: async () => {
        try {
          await api(g ? `/api/groups/${g.id}` : '/api/groups', { method: g ? 'PUT' : 'POST', body: { name: name.value, color: color.value } });
          toast('ذخیره شد');
          refresh();
        } catch (err) { toast(err.message); }
      } }, g ? 'ذخیره' : 'افزودن');
      const del = g ? h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`گروه «${g.name}» حذف شود؟`)) return;
        try { await api(`/api/groups/${g.id}`, { method: 'DELETE' }); toast('حذف شد'); refresh(); } catch (err) { toast(err.message); }
      } }, 'حذف') : null;
      return h('div', { class: 'group-row' }, color, name, g ? h('span', { class: 'muted' }, `${fa(g.count)} مخاطب`) : null, save, del);
    };

    const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'فایل CSV' });
    const importOut = h('div', { 'aria-live': 'polite' });
    const importBtn = h('button', { class: 'btn', onclick: async () => {
      const f = fileInput.files[0];
      if (!f) { toast('ابتدا یک فایل CSV انتخاب کنید'); return; }
      try {
        const r = await api('/api/import', { method: 'POST', body: await f.text() });
        importOut.replaceChildren(
          h('p', null, `ایجاد شد: ${fa(r.created)} — تکراری: ${fa(r.duplicates)} — ناموفق: ${fa(r.failed)}`),
          r.errors.length ? h('ul', { class: 'error' }, r.errors.map((e) => h('li', null, `سطر ${fa(e.row)}: ${e.message}`))) : null,
        );
        fileInput.value = '';
      } catch (err) { importOut.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message)); }
    } }, 'ورود CSV');

    view.replaceChildren(
      h('div', { class: 'panel' }, h('h2', null, 'گروه‌ها / بخش‌ها'), groups.map(groupRow), h('h3', null, 'گروه جدید'), groupRow(null)),
      h('div', { class: 'panel' },
        h('h2', null, 'ورود و خروج داده'),
        h('p', null, h('a', { class: 'btn', href: '/api/export.csv', download: '' }, 'دریافت CSV مخاطبین')),
        h('p', { class: 'muted' }, 'ستون‌های ورود: نام، نام خانوادگی، سمت، گروه، کد داخلی، خط مستقیم، موبایل، تلفن منزل، ایمیل، آدرس، کد ملی، یادداشت. ردیف‌های تکراری نادیده گرفته می‌شوند و گروه ناموجود ساخته می‌شود.'),
        h('div', { class: 'group-row' }, fileInput, importBtn),
        importOut,
      ),
      h('div', { class: 'panel' },
        h('h2', null, 'پشتیبان‌گیری'),
        h('p', { class: 'muted' }, 'یک نسخه سازگار از فایل دیتابیس در پوشه backups کنار دیتابیس ذخیره می‌شود (۳۰ نسخه آخر نگه داشته می‌شود).'),
        h('button', { class: 'btn', onclick: async () => {
          try { toast(`ساخته شد: ${(await api('/api/backup', { method: 'POST' })).file}`); } catch (err) { toast(err.message); }
        } }, 'ساخت پشتیبان'),
      ),
    );
  }

  // ───────── دیالوگ‌ها ─────────
  const PERSON_FIELDS = [
    ['first_name', 'نام', 'text'], ['last_name', 'نام خانوادگی', 'text'],
    ['title', 'سمت', 'text'], ['group_id', 'گروه / بخش', 'select'],
    ['extension', 'کد داخلی', 'tel'], ['direct_line', 'خط مستقیم', 'tel'],
    ['mobile', 'موبایل', 'tel'], ['home_phone', 'تلفن منزل', 'tel'],
    ['email', 'ایمیل', 'email'], ['national_id', 'کد ملی', 'tel'],
    ['address', 'آدرس', 'textarea'], ['note', 'یادداشت', 'textarea'],
  ];

  async function openPerson(id) {
    let p;
    try { p = (await api(`/api/persons/${id}`)).person; } catch (err) { toast(err.message); return; }
    const rows = [['سمت', p.title], ['گروه', p.group_name ? chip(p.group_name, p.group_color) : ''],
      ['کد داخلی', p.extension, true], ['خط مستقیم', p.direct_line, true]];
    if (isOp()) rows.push(['موبایل', p.mobile, true], ['تلفن منزل', p.home_phone, true], ['ایمیل', p.email, true], ['آدرس', p.address], ['کد ملی', p.national_id, true]);
    rows.push(['یادداشت', p.note]);
    openDialog(
      h('h2', null, fullName(p)),
      h('dl', null, rows.map(([l, v, isNum]) => [h('dt', null, l), h('dd', null, v ? (isNum ? num(v) : v) : h('span', { class: 'muted' }, '—'))])),
      h('div', { class: 'dlg-actions' },
        isOp() ? h('button', { class: 'btn primary', onclick: () => personForm(p) }, 'ویرایش') : null,
        isOp() ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`«${fullName(p)}» حذف شود؟`)) return;
          try { await api(`/api/persons/${p.id}`, { method: 'DELETE' }); closeDialog(); toast('حذف شد'); refresh(); } catch (err) { toast(err.message); }
        } }, 'حذف') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: closeDialog }, 'بستن'),
      ),
    );
  }

  async function personForm(p) {
    if (!state.groups.length) {
      try { state.groups = (await api('/api/groups')).items; } catch { /* ignore */ }
    }
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { novalidate: true },
      h('h2', null, p ? 'ویرایش مخاطب' : 'مخاطب جدید'),
      h('div', { class: 'form-grid' }, PERSON_FIELDS.map(([key, label, type]) => {
        let control;
        if (type === 'select') {
          control = h('select', { name: key },
            h('option', { value: '' }, '— بدون گروه —'),
            state.groups.map((g) => h('option', { value: String(g.id), selected: p && p.group_id === g.id }, g.name)));
        } else if (type === 'textarea') {
          control = h('textarea', { name: key, rows: '2' });
          control.value = p ? p[key] || '' : '';
        } else {
          control = h('input', { name: key, type: type === 'tel' ? 'text' : type, inputmode: type === 'tel' ? 'tel' : null, dir: type === 'tel' || type === 'email' ? 'ltr' : null, value: p ? p[key] || '' : '' });
        }
        return h('label', { class: `field${type === 'textarea' ? ' wide' : ''}` }, label, control);
      })),
      err,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره'),
        h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'انصراف'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      for (const [key] of PERSON_FIELDS) body[key] = form.elements[key].value;
      body.group_id = body.group_id === '' ? null : Number(body.group_id);
      try {
        await api(p ? `/api/persons/${p.id}` : '/api/persons', { method: p ? 'PUT' : 'POST', body });
        closeDialog();
        toast('ذخیره شد');
        refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    openDialog(form);
    form.elements.first_name.focus();
  }

  function internalForm(r) {
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { novalidate: true },
      h('h2', null, r ? 'ویرایش داخلی' : 'داخلی جدید'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field wide' }, 'بخش', h('input', { name: 'department', type: 'text', value: r ? r.department : '' })),
        h('label', { class: 'field' }, 'شماره داخلی', h('input', { name: 'number', type: 'text', dir: 'ltr', inputmode: 'numeric', value: r ? r.number : '' })),
        h('label', { class: 'field' }, 'توضیح', h('input', { name: 'note', type: 'text', value: r ? r.note : '' })),
      ),
      err,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره'),
        r ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm(`داخلی «${r.department}» حذف شود؟`)) return;
          try { await api(`/api/internals/${r.id}`, { method: 'DELETE' }); closeDialog(); toast('حذف شد'); refresh(); } catch (ex) { err.textContent = ex.message; }
        } }, 'حذف') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'انصراف'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { department: form.elements.department.value, number: form.elements.number.value, note: form.elements.note.value };
      try {
        await api(r ? `/api/internals/${r.id}` : '/api/internals', { method: r ? 'PUT' : 'POST', body });
        closeDialog();
        toast('ذخیره شد');
        refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    openDialog(form);
    form.elements.department.focus();
  }

  function loginDialog() {
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { novalidate: true },
      h('h2', null, 'ورود'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field wide' }, 'نام کاربری', h('input', { name: 'username', type: 'text', dir: 'ltr', autocomplete: 'username', autocapitalize: 'none' })),
        h('label', { class: 'field wide' }, 'رمز عبور', h('input', { name: 'password', type: 'password', dir: 'ltr', autocomplete: 'current-password' })),
      ),
      err,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'ورود'),
        h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'انصراف'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/login', { method: 'POST', body: { username: form.elements.username.value, password: form.elements.password.value } });
        state.user = r.user;
        closeDialog();
        if (r.user.mustChangePassword) {
          passwordDialog(true);
          return;
        }
        state.groups = (await api('/api/groups')).items;
        state.tab = 'contacts';
        renderAll();
      } catch (ex) { err.textContent = ex.message; }
    });
    openDialog(form);
    form.elements.username.focus();
  }

  function passwordDialog(forced = false) {
    forcedPasswordOpen = forced;
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { novalidate: true },
      h('h2', null, forced ? 'تغییر رمز عبور (اولین ورود)' : 'تغییر رمز عبور'),
      forced ? h('p', null, 'برای امنیت، در اولین ورود باید رمز عبور را تغییر دهید. تا وقتی رمز عوض نشود، بقیه بخش‌ها باز نمی‌شوند.') : null,
      h('div', { class: 'form-grid' },
        h('label', { class: 'field wide' }, 'رمز فعلی', h('input', { name: 'current', type: 'password', dir: 'ltr', autocomplete: 'current-password' })),
        h('label', { class: 'field wide' }, 'رمز جدید (حداقل ۸ نویسه)', h('input', { name: 'next', type: 'password', dir: 'ltr', autocomplete: 'new-password' })),
      ),
      err,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره'),
        forced ? null : h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'انصراف'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/me/password', { method: 'POST', body: { current: form.elements.current.value, new: form.elements.next.value } });
        forcedPasswordOpen = false;
        closeDialog();
        toast('رمز عبور تغییر کرد');
        if (forced) {
          const me = await api('/api/me');
          state.user = me.user;
          state.groups = (await api('/api/groups')).items;
          state.tab = 'contacts';
          renderAll();
        }
      } catch (ex) { err.textContent = ex.message; }
    });
    openDialog(form);
    form.elements.current.focus();
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.user = null;
    state.groups = [];
    state.tab = 'internals';
    renderAll();
  }

  // ───────── شروع ─────────
  async function init() {
    try {
      const me = await api('/api/me');
      state.user = me.user;
      if (state.user && !state.user.mustChangePassword) state.groups = (await api('/api/groups')).items;
      state.tab = state.user ? 'contacts' : 'internals';
    } catch (err) {
      if (err.network) {
        state.offline = true;
        state.tab = 'internals';
      } else {
        state.user = null;
      }
    }
    renderAll();
    if (state.user && state.user.mustChangePassword) passwordDialog(true);
    searchInput.focus();
  }

  init();
})();
