'use strict';

const $ = (id) => document.getElementById(id);
const LS = {
  city: 'rewir.city', street: 'rewir.street', fav: 'rewir.fav',
  done: 'rewir.done', working: 'rewir.working', author: 'rewir.author',
};
const ANON = 'Nieznany';
const YEAR = 365 * 24 * 3600;

const state = {
  role: null,
  adminLeft: 0,
  cities: [],
  cityId: localStorage.getItem(LS.city) || null,
  streetId: localStorage.getItem(LS.street) || null,
  fav: new Set(JSON.parse(localStorage.getItem(LS.fav) || '[]')),
  done: new Set(JSON.parse(localStorage.getItem(LS.done) || '[]')),
  author: localStorage.getItem(LS.author) || '',
  tab: 'todo',
  openInf: null,
};

const isAdmin = () => state.role === 'admin';
const persist = () => {
  state.cityId ? localStorage.setItem(LS.city, state.cityId) : localStorage.removeItem(LS.city);
  state.streetId ? localStorage.setItem(LS.street, state.streetId) : localStorage.removeItem(LS.street);
  localStorage.setItem(LS.fav, JSON.stringify([...state.fav]));
  localStorage.setItem(LS.done, JSON.stringify([...state.done]));
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- сеть ---------- */
async function api(path, method = 'GET', body) {
  const headers = { 'X-Author': encodeURIComponent(state.author || '') };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin', headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !['/auth/login', '/me'].includes(path)) {
    showLock('Sesja wygasła. Zaloguj się ponownie.');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) syncMe();           // права админа могли погаснуть
  if (!res.ok) throw new Error(data.error || 'Błąd serwera');
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('toast--bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- вход ---------- */
function showLock(msg = '') {
  $('app').hidden = true;
  $('lock').hidden = false;
  $('lock-error').textContent = msg;
  $('lock-input').value = '';
}

$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const me = await api('/auth/login', 'POST', { password: $('lock-input').value });
    applyMe(me);
    $('lock').hidden = true;
    $('app').hidden = false;
    await boot();
  } catch (err) {
    $('lock-error').textContent = err.message;
    $('lock-input').value = '';
  } finally {
    btn.disabled = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/auth/logout', 'POST').catch(() => {});
  showLock('Wylogowano.');
});

/* ---------- режим администратора ---------- */
function applyMe(me) {
  const was = state.role;
  state.role = me.role;
  state.adminLeft = me.admin_left || 0;
  renderChrome();
  if (was && was !== me.role) {
    render();
    if (!$('work').hidden) renderHouses();
    if (state.openInf) infoDialog(state.openInf);
  }
}

async function syncMe() {
  try { applyMe(await api('/me')); } catch { /* сессия умерла — покажет lock */ }
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function renderChrome() {
  const admin = isAdmin();
  $('role-badge').textContent = admin ? 'Administrator' : 'Pracownik';
  $('role-badge').classList.toggle('badge--admin', admin);
  $('btn-elevate').hidden = admin;
  $('btn-demote').hidden = !admin;
  $('btn-demote').innerHTML = `Wyjdź z trybu <span class="admin-left">${mmss(state.adminLeft)}</span>`;
  ['city-add', 'city-del', 'street-add', 'btn-admin', 'btn-log'].forEach((id) => ($(id).hidden = !admin));
  $('btn-name').textContent = state.author || ANON;
}

setInterval(() => {
  if (!isAdmin()) return;
  state.adminLeft -= 1;
  if (state.adminLeft <= 0) {
    syncMe();
    toast('Tryb administratora wygasł');
  } else {
    $('btn-demote').innerHTML = `Wyjdź z trybu <span class="admin-left">${mmss(state.adminLeft)}</span>`;
  }
}, 1000);

$('btn-elevate').addEventListener('click', () =>
  modal('Tryb administratora', `
    <p class="note-meta">Uprawnienia wygasają po 2 godzinach. Hasło nie jest nigdzie zapisywane.</p>
    <label for="m-pass">Hasło administratora</label>
    <input id="m-pass" type="password" autocomplete="current-password">`,
    async () => {
      applyMe(await api('/auth/elevate', 'POST', { password: $('m-pass').value }));
      toast('Tryb administratora włączony');
    }));

$('btn-demote').addEventListener('click', async () => {
  applyMe(await api('/auth/demote', 'POST'));
  toast('Tryb administratora wyłączony');
});

/* ---------- подпись ---------- */
$('btn-name').addEventListener('click', () =>
  modal('Twój podpis', `
    <p class="note-meta">Podpis trafia do rankingu i dziennika. Zostaw puste — będziesz „${ANON}”.</p>
    <label for="m-author">Imię lub nazwisko</label>
    <input id="m-author" maxlength="24" value="${esc(state.author)}">`,
    async () => {
      state.author = $('m-author').value.trim().slice(0, 24);
      localStorage.setItem(LS.author, state.author);
      renderChrome();
      await loadRanking();
      toast('Podpis zapisany');
    }));

/* ---------- загрузка ---------- */
async function boot() {
  await refreshData();
  renderChrome();
  if (!state.cities.some((c) => c.id === state.cityId)) {
    state.cityId = state.cities[0]?.id || null;
    state.streetId = null;
  }
  render();
  loadRanking();
  if (localStorage.getItem(LS.working) === '1' && currentStreet()) enterWork();
}

const currentCity = () => state.cities.find((c) => c.id === state.cityId) || null;
const currentStreet = () => currentCity()?.streets.find((s) => s.id === state.streetId) || null;
const findHouse = (id) => currentStreet()?.houses.find((h) => h.id === id) || null;

async function refreshData() {
  const { cities } = await api('/data');
  state.cities = cities;
}

/* ---------- рейтинг ---------- */
async function loadRanking() {
  try {
    const { ranking } = await api('/stats');
    const me = state.author || ANON;
    $('ranking').innerHTML = ranking.length
      ? ranking.slice(0, 10).map((r) => `<li>
          <span class="ranking__place"></span>
          <span class="ranking__name ${r.name === me ? 'ranking__me' : ''}">${esc(r.name)}</span>
          <span class="ranking__score">${r.total}<span class="ranking__break">${r.houses}/${r.codes}/${r.notes}</span></span>
        </li>`).join('')
      : '<li class="hint">Nikt jeszcze nic nie dopisał. Bądź pierwszy.</li>';
    document.querySelectorAll('.ranking__place').forEach((el, i) => (el.textContent = i + 1));
  } catch { /* рейтинг не критичен */ }
}

/* ---------- обычный режим ---------- */
function render() {
  persist();
  const city = currentCity();
  $('city').innerHTML = state.cities.length
    ? state.cities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : '<option value="">Brak miast</option>';
  if (city) $('city').value = city.id;

  const streets = city?.streets || [];
  const favs = streets.filter((s) => state.fav.has(s.id));
  $('fav-panel').hidden = favs.length === 0;
  $('fav-list').innerHTML = favs.map(streetRow).join('');

  const q = $('street-filter').value.trim().toLowerCase();
  const shown = streets.filter((s) => s.name.toLowerCase().includes(q));
  $('street-list').innerHTML = shown.length
    ? shown.map(streetRow).join('')
    : `<li class="hint">${streets.length ? 'Nic nie znaleziono.' :
        (isAdmin() ? 'Brak ulic. Dodaj pierwszą przyciskiem „+”.' : 'Brak ulic. Zgłoś się do administratora.')}</li>`;

  const s = currentStreet();
  $('btn-start').disabled = !s;
  $('btn-start').textContent = s ? `Rozpocznij obchód: ${s.name}` : 'Wybierz ulicę';
}

function streetRow(s) {
  const del = isAdmin() ? `<button class="trash" data-del-street="${s.id}" title="Usuń ulicę">✕</button>` : '';
  return `<li>
    <button class="star" data-star="${s.id}" data-on="${state.fav.has(s.id) ? '1' : '0'}" title="Ulubione">★</button>
    <button class="street-name" data-street="${s.id}" aria-current="${s.id === state.streetId}">
      ${esc(s.name)} <span class="house-count">· ${s.houses.length}</span>
    </button>${del}</li>`;
}

$('city').addEventListener('change', (e) => {
  state.cityId = e.target.value || null;
  state.streetId = null;
  render();
});
$('street-filter').addEventListener('input', render);

/* ---------- делегирование ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.street) { state.streetId = t.dataset.street; render(); }
    if (t.dataset.star) {
      const id = t.dataset.star;
      state.fav.has(id) ? state.fav.delete(id) : state.fav.add(id);
      render();
    }
    if (t.dataset.delStreet) {
      const s = currentCity().streets.find((x) => x.id === t.dataset.delStreet);
      if (!confirm(`Usunąć ulicę „${s.name}” razem z domami?`)) return;
      await api('/streets/' + s.id, 'DELETE');
      if (state.streetId === s.id) state.streetId = null;
      state.fav.delete(s.id);
      await boot();
      toast('Ulica usunięta');
    }
    if (t.dataset.house) toggleDone(t.dataset.house);
    if (t.dataset.undo) toggleDone(t.dataset.undo);
    if (t.dataset.inf) infoDialog(t.dataset.inf);
    if (t.dataset.editHouse) editHouseDialog(t.dataset.editHouse);
    if (t.dataset.delHouse) {
      if (!confirm('Usunąć dom razem z kodami?')) return;
      await api('/houses/' + t.dataset.delHouse, 'DELETE');
      await refreshData();
      renderHouses();
      toast('Dom usunięty');
    }
  } catch (err) { if (err.message !== 'unauthorized') toast(err.message, true); }
});

/* ---------- админ: города и улицы ---------- */
$('city-add').addEventListener('click', () =>
  modal('Nowe miasto', `<label for="m-city">Nazwa</label><input id="m-city">`, async () => {
    const city = await api('/cities', 'POST', { name: $('m-city').value });
    await refreshData();
    state.cityId = city.id;
    state.streetId = null;
    render();
    toast('Miasto dodane');
  }));

$('city-del').addEventListener('click', async () => {
  const c = currentCity();
  if (!c || !confirm(`Usunąć miasto „${c.name}” razem z ulicami i domami?`)) return;
  await api('/cities/' + c.id, 'DELETE');
  state.cityId = null;
  state.streetId = null;
  await boot();
  toast('Miasto usunięte');
});

$('street-add').addEventListener('click', () => {
  if (!currentCity()) return toast('Najpierw wybierz miasto', true);
  modal('Nowa ulica', `<label for="m-street">Nazwa</label><input id="m-street">`, async () => {
    const s = await api(`/cities/${state.cityId}/streets`, 'POST', { name: $('m-street').value });
    await refreshData();
    state.streetId = s.id;
    render();
    toast('Ulica dodana');
  });
});

/* ---------- режим обхода ---------- */
$('btn-start').addEventListener('click', enterWork);
$('btn-exit').addEventListener('click', exitWork);

function enterWork() {
  const s = currentStreet();
  if (!s) return;
  localStorage.setItem(LS.working, '1');
  $('browse').hidden = true;
  $('work').hidden = false;
  $('work-city').textContent = currentCity().name;
  $('work-street').textContent = s.name;
  state.tab = 'todo';
  syncTabs();
  hideEndButton();
  renderHouses();
}

function exitWork() {
  localStorage.removeItem(LS.working);
  $('work').hidden = true;
  $('browse').hidden = false;
  render();
  loadRanking();
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    syncTabs();
    renderHouses();
  }));

const syncTabs = () => document.querySelectorAll('.tab').forEach((t) =>
  t.classList.toggle('tab--on', t.dataset.tab === state.tab));

function toggleDone(id) {
  state.done.has(id) ? state.done.delete(id) : state.done.add(id);
  persist();
  renderHouses();
}

function renderHouses() {
  const s = currentStreet();
  if (!s) return exitWork();
  const todo = s.houses.filter((h) => !state.done.has(h.id));
  const done = s.houses.filter((h) => state.done.has(h.id));
  $('count-todo').textContent = todo.length;
  $('count-done').textContent = done.length;

  const showTodo = state.tab === 'todo';
  $('houses').hidden = !showTodo;
  $('houses-done').hidden = showTodo;
  $('empty-todo').hidden = !(showTodo && todo.length === 0);
  $('empty-done').hidden = !(!showTodo && done.length === 0);
  $('house-add').hidden = !showTodo;

  $('houses').innerHTML = todo.map((h) => houseCard(h, false)).join('');
  $('houses-done').innerHTML = done.map((h) => houseCard(h, true)).join('');
}

function codeLines(h) {
  if (!h.codes.length) return `<div class="codes codes--none">brak kodów</div>`;
  return `<div class="codes">${h.codes.map((c) => `<div class="code-line">
      <span class="code-line__label">${c.label ? esc(c.label) : '—'}</span>
      <span class="code-line__value">${esc(c.value)}</span>
    </div>`).join('')}</div>`;
}

function houseCard(h, isDone) {
  const note = h.note ? `<div class="house__note">${esc(h.note)}</div>` : '';
  const stale = h.codes.length && h.updated && Date.now() / 1000 - h.updated > YEAR
    ? `<div class="stale">kody starsze niż rok</div>` : '';
  const inf = `<button class="inf ${h.note ? 'inf--on' : ''}" data-inf="${h.id}">INF</button>`;
  const admin = isAdmin()
    ? `<button data-edit-house="${h.id}">✎</button><button data-del-house="${h.id}">✕</button>` : '';
  const side = isDone ? `<button class="undo" data-undo="${h.id}">Cofnij</button>${inf}` : `${inf}${admin}`;

  return `<li class="house ${isDone ? 'house--done' : ''}">
    <button class="house__main" ${isDone ? 'disabled' : `data-house="${h.id}"`}>
      <span class="house__num">${esc(h.number)}</span>
      <span class="house__meta">${codeLines(h)}${note}${stale}</span>
    </button>
    <div class="house__side">${side}</div></li>`;
}

/* ---------- INF: коды и заметка ---------- */
function infoDialog(id) {
  const h = findHouse(id);
  if (!h) return;
  state.openInf = id;
  const when = h.updated ? new Date(h.updated * 1000).toLocaleDateString('pl-PL') : '—';

  const rows = h.codes.length
    ? h.codes.map((c) => `<div class="code-edit">
        <span class="code-edit__text">
          <span class="code-edit__label">${c.label ? esc(c.label) : 'bez etykiety'}</span>
          <span class="code-edit__value">${esc(c.value)}</span>
        </span>
        ${isAdmin() ? `<button class="code-edit__act" data-code-edit="${c.id}">✎</button>
        <button class="code-edit__act code-edit__act--del" data-code-del="${c.id}">✕</button>` : ''}
      </div>`).join('')
    : `<p class="note-view note-view--empty">Brak kodów. Dopisz pierwszy.</p>`;

  modal(`Dom ${h.number}`, `
    <p class="note-meta">Ostatnia zmiana: ${when}</p>
    <div id="inf-codes">${rows}</div>
    <div class="code-form">
      <input class="lbl" id="m-label" maxlength="30" placeholder="Klatka 1 / Brama">
      <input class="val" id="m-value" maxlength="40" placeholder="Kod">
    </div>
    <button id="m-add-code" class="btn btn--wide">Dopisz kod</button>
    <label for="m-note" style="margin-top:14px">Notatka (widoczna dla wszystkich)</label>
    <textarea id="m-note" maxlength="400" placeholder="np. skrzynki w piwnicy, furtka od podwórka">${esc(h.note || '')}</textarea>
    <button id="m-save-note" class="btn btn--wide">Zapisz notatkę</button>`, null);

  $('m-add-code').addEventListener('click', () => guard(async () => {
    await api(`/houses/${id}/codes`, 'POST', { label: $('m-label').value, value: $('m-value').value });
    await refreshData();
    renderHouses();
    loadRanking();
    infoDialog(id);
    toast('Kod dopisany');
  }));

  $('m-save-note').addEventListener('click', () => guard(async () => {
    await api('/houses/' + id, 'PATCH', { note: $('m-note').value });
    await refreshData();
    renderHouses();
    loadRanking();
    toast('Notatka zapisana');
  }));

  $('inf-codes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.codeDel) guard(async () => {
      if (!confirm('Usunąć ten kod?')) return;
      await api('/codes/' + b.dataset.codeDel, 'DELETE');
      await refreshData();
      renderHouses();
      infoDialog(id);
      toast('Kod usunięty');
    });
    if (b.dataset.codeEdit) {
      const c = h.codes.find((x) => x.id === b.dataset.codeEdit);
      modal('Edytuj kod', `
        <label for="m-label2">Etykieta</label><input id="m-label2" maxlength="30" value="${esc(c.label)}">
        <label for="m-value2">Kod</label><input id="m-value2" maxlength="40" value="${esc(c.value)}">`,
        async () => {
          await api('/codes/' + c.id, 'PATCH', { label: $('m-label2').value, value: $('m-value2').value });
          await refreshData();
          renderHouses();
          setTimeout(() => infoDialog(id), 0);   // после closeModal вернём карточку дома
          toast('Kod zapisany');
        });
    }
  });
}

async function guard(fn) {
  try { await fn(); }
  catch (err) { if (err.message !== 'unauthorized') $('modal-error').textContent = err.message; }
}

/* ---------- дома ---------- */
$('house-add').addEventListener('click', () => {
  if (!currentStreet()) return;
  modal('Nowy dom', `
    <label for="m-num">Numer domu</label><input id="m-num">
    <p class="note-meta">Pierwszy kod opcjonalnie — kolejne dopiszesz przez INF.</p>
    <div class="code-form">
      <input class="lbl" id="m-label" maxlength="30" placeholder="Klatka 1 / Brama">
      <input class="val" id="m-value" maxlength="40" placeholder="Kod">
    </div>
    <label for="m-note">Notatka (opcjonalnie)</label><textarea id="m-note" maxlength="400"></textarea>`,
    async () => {
      const codes = $('m-value').value.trim()
        ? [{ label: $('m-label').value, value: $('m-value').value }] : [];
      await api(`/streets/${state.streetId}/houses`, 'POST',
        { number: $('m-num').value, codes, note: $('m-note').value });
      await refreshData();
      renderHouses();
      loadRanking();
      toast('Dom dodany');
    });
});

function editHouseDialog(id) {
  const h = findHouse(id);
  modal('Edytuj dom', `
    <label for="m-num">Numer domu</label><input id="m-num" value="${esc(h.number)}">
    <label for="m-note">Notatka</label><textarea id="m-note" maxlength="400">${esc(h.note || '')}</textarea>
    <p class="note-meta">Kody edytujesz przez INF.</p>`,
    async () => {
      await api('/houses/' + id, 'PATCH', { number: $('m-num').value, note: $('m-note').value });
      await refreshData();
      renderHouses();
      toast('Zapisano');
    });
}

/* ---------- конец смены ---------- */
$('reveal-end').addEventListener('click', () => {
  const shown = !$('btn-end').hidden;
  $('btn-end').hidden = shown;
  $('reveal-end').setAttribute('aria-expanded', String(!shown));
});
function hideEndButton() {
  $('btn-end').hidden = true;
  $('reveal-end').setAttribute('aria-expanded', 'false');
}
$('btn-end').addEventListener('click', () => {
  if (!confirm('Zakończyć zmianę? Wszystkie zaznaczenia obchodu znikną.')) return;
  state.done.clear();
  persist();
  hideEndButton();
  exitWork();
  toast('Zmiana zamknięta');
});

/* ---------- журнал ---------- */
const ACTION_PL = {
  house_add: 'dodał dom', house_del: 'usunął dom',
  code_add: 'dopisał kod', code_edit: 'zmienił kod', code_del: 'usunął kod',
  note_set: 'zapisał notatkę', note_clear: 'usunął notatkę',
  city_add: 'dodał miasto', city_del: 'usunął miasto',
  street_add: 'dodał ulicę', street_del: 'usunął ulicę',
  password_change: 'zmienił hasło', elevate: 'włączył tryb admina', demote: 'wyłączył tryb admina',
};
$('btn-log').addEventListener('click', async () => {
  const { entries } = await api('/log');
  const rows = entries.map((e) => `<li>
      <span><b>${esc(e.author)}</b> ${ACTION_PL[e.action] || esc(e.action)}
        ${e.extra ? '· ' + esc(e.extra) : ''}<br>
        <span style="color:var(--ink-soft)">${esc(e.ip)} · ${esc(e.role)}</span></span>
      <time>${new Date(e.ts * 1000).toLocaleString('pl-PL')}</time>
    </li>`).join('') || '<li class="hint">Dziennik jest pusty.</li>';
  modal('Dziennik', `<ul class="log">${rows}</ul>`, null);
});

/* ---------- смена паролей ---------- */
$('btn-admin').addEventListener('click', () =>
  modal('Zmiana hasła', `
    <p class="note-meta">Zmiana hasła dostępu wylogowuje wszystkich. Zmiana hasła administratora gasi wszystkie tryby admina.</p>
    <label for="m-target">Które hasło zmieniamy</label>
    <select id="m-target">
      <option value="view">Hasło dostępu (pracownik)</option>
      <option value="admin">Hasło administratora</option>
    </select>
    <label for="m-cur">Obecne hasło administratora</label>
    <input id="m-cur" type="password" autocomplete="current-password">
    <label for="m-new">Nowe hasło (min. 8 znaków)</label>
    <input id="m-new" type="password" autocomplete="new-password">`,
    async () => {
      const r = await api('/admin/password', 'POST', {
        target: $('m-target').value, current_password: $('m-cur').value, new_password: $('m-new').value,
      });
      if (r.relogin) { showLock('Hasło zmienione. Zaloguj się ponownie.'); return; }
      await syncMe();
      toast('Hasło zmienione');
    }));

/* ---------- модалка ---------- */
let onOk = null;
function modal(title, html, handler) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  $('modal-error').textContent = '';
  $('modal').hidden = false;
  onOk = handler;
  $('modal-ok').hidden = !handler;
  $('modal-cancel').textContent = handler ? 'Anuluj' : 'Zamknij';
  if (handler) $('modal-body').querySelector('input,select,textarea')?.focus();
}
function closeModal() { $('modal').hidden = true; onOk = null; state.openInf = null; }
$('modal-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
$('modal-ok').addEventListener('click', async () => {
  if (!onOk) return;
  $('modal-ok').disabled = true;
  try { await onOk(); closeModal(); }
  catch (err) { if (err.message !== 'unauthorized') $('modal-error').textContent = err.message; }
  finally { $('modal-ok').disabled = false; }
});
document.addEventListener('keydown', (e) => {
  if ($('modal').hidden) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !$('modal-ok').hidden) $('modal-ok').click();
});

/* ---------- старт ---------- */
(async function init() {
  try {
    applyMe(await api('/me'));
    $('lock').hidden = true;
    $('app').hidden = false;
    await boot();
  } catch {
    showLock();
  }
})();
