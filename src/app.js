'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const PROTO_LABEL = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  shadowsocks: 'Shadowsocks',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  anytls: 'AnyTLS',
  socks: 'SOCKS',
  http: 'HTTP',
};

const PAGE_META = {
  home: ['Главная', 'Управление подключением'],
  servers: ['Серверы', 'Список доступных узлов'],
  subs: ['Подписки', 'Импорт и обновление конфигураций'],
  routing: ['Маршрутизация', 'Какие приложения и сайты идут через VPN'],
  logs: ['Журнал', 'События ядра sing-box'],
  settings: ['Настройки', 'Поведение приложения'],
};

let S = null;
let currentPage = 'home';
let logInitialized = false;
let pinging = false;
let domainsDirty = false;
const history = { up: Array(60).fill(0), down: Array(60).fill(0) };
let modalResolve = null;

/* ---------------- utils ---------------- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanError(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

let toastTimer = null;
function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, type === 'error' ? 5200 : 3000);
}

async function guard(fn, successMessage) {
  try {
    const result = await fn();
    if (successMessage) toast(successMessage, 'success');
    return result;
  } catch (error) {
    toast(cleanError(error), 'error');
    return null;
  }
}

function formatRate(bytes) {
  if (!bytes) return ['0', 'Б/с'];
  if (bytes < 1024) return [String(Math.round(bytes)), 'Б/с'];
  if (bytes < 1024 * 1024) return [(bytes / 1024).toFixed(1), 'КБ/с'];
  return [(bytes / 1024 / 1024).toFixed(2), 'МБ/с'];
}

function formatBytes(bytes) {
  if (!bytes) return '0 МБ';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function pingHtml(latency) {
  if (latency === null || latency === undefined) return '<span class="ping">—</span>';
  if (latency < 0) return '<span class="ping">—</span>';
  const cls = latency < 90 ? 'good' : latency < 180 ? 'mid' : 'bad';
  return `<span class="ping ${cls}">${Math.round(latency)} мс</span>`;
}

function pingClass(latency) {
  if (latency === null || latency === undefined || latency < 0) return '';
  return latency < 90 ? 'good' : latency < 180 ? 'mid' : 'bad';
}

function selectedServer() {
  return S?.servers.find((server) => server.id === S.selectedServerId) || null;
}

function splitModeLabel(mode) {
  if (mode === 'only') return 'Только выбранные';
  if (mode === 'except') return 'Всё, кроме выбранных';
  return 'Весь трафик';
}

/* ---------------- render ---------------- */

function render() {
  if (!S) return;
  $('#appVersion').textContent = `v${S.appVersion}`;

  const badge = $('#adminBadge');
  badge.className = `admin-badge ${S.admin ? 'ok' : 'error'}`;
  $('#adminText').textContent = S.admin ? 'Администратор' : 'Без прав администратора';

  const status = S.connection.status;
  const statusText = { connected: 'Защищено', connecting: 'Подключение…', error: 'Ошибка' }[status] || 'Отключено';
  $('#statusPill').dataset.status = status;
  $('#statusText').textContent = statusText;

  renderHome();
  renderServers();
  renderSubscriptions();
  renderRouting();
  renderSettings();
  renderLogs();
}

function renderHome() {
  const status = S.connection.status;
  const orb = $('#connectBtn');
  orb.dataset.status = status;
  orb.disabled = status === 'connecting';
  $('#orbLabel').textContent = status === 'connected' ? 'Отключить' : status === 'connecting' ? 'Подключение' : 'Подключить';

  const hero = $('.hero');
  hero.dataset.status = status;

  const titles = {
    connected: ['Подключено', 'Весь выбранный трафик защищён'],
    connecting: ['Подключение…', 'Запускаем ядро и создаём туннель'],
    error: ['Не удалось подключиться', S.connection.error || 'Проверьте журнал'],
  };
  const [title, sub] = titles[status] || [
    'Отключено',
    selectedServer() ? 'Нажмите «Подключить», чтобы включить VPN' : 'Сначала добавьте сервер или подписку',
  ];
  $('#heroTitle').textContent = title;
  $('#heroSub').textContent = sub;

  const server = selectedServer();
  const body = $('#serverCardBody');
  if (!server) {
    body.innerHTML = `
      <div class="muted">Сервер не выбран</div>
      <div class="server-actions">
        <button class="btn small primary" data-page-link="subs">Добавить подписку</button>
        <button class="btn small" data-page-link="servers">Выбрать сервер</button>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="server-name">${esc(server.name)}</div>
      <div class="server-meta">
        <span class="badge">${esc(PROTO_LABEL[server.protocol] || server.protocol)}</span>
        <span>${esc(server.host)}:${server.port}</span>
        ${pingHtml(server.latency)}
      </div>
      <div class="server-actions">
        <button class="btn small" data-page-link="servers">Сменить сервер</button>
      </div>`;
  }

  $('#splitSummary').textContent = splitModeLabel(S.settings.splitMode);
  $('#ruSummary').textContent = S.settings.bypassRu ? 'Напрямую' : 'Через VPN';

  if (status !== 'connected') {
    $('#speedDown').textContent = '0';
    $('#unitDown').textContent = 'Б/с';
    $('#speedUp').textContent = '0';
    $('#unitUp').textContent = 'Б/с';
  }
  $('#totalDown').textContent = formatBytes(S.stats.totalDown);
  $('#totalUp').textContent = formatBytes(S.stats.totalUp);
}

function renderServers() {
  const query = ($('#serverSearch')?.value || '').trim().toLowerCase();
  const servers = S.servers.filter((server) => {
    if (!query) return true;
    return (
      server.name.toLowerCase().includes(query) ||
      server.host.toLowerCase().includes(query) ||
      (PROTO_LABEL[server.protocol] || '').toLowerCase().includes(query)
    );
  });

  const list = $('#serverList');
  list.innerHTML = servers
    .map(
      (server) => `
      <div class="row-card ${server.id === S.selectedServerId ? 'selected' : ''}" data-id="${server.id}">
        <div class="radio" data-action="select"></div>
        <div class="row-main" data-action="select">
          <div class="row-title">${esc(server.name)}</div>
          <div class="row-sub">${esc(PROTO_LABEL[server.protocol] || server.protocol)} · ${esc(server.host)}:${server.port}</div>
        </div>
        <span class="badge">${esc(PROTO_LABEL[server.protocol] || server.protocol)}</span>
        ${pingHtml(server.latency)}
        <button class="icon-btn" data-action="ping" title="Проверить пинг">
          <svg viewBox="0 0 24 24"><path d="M4 18l5-6 4 3 7-9"/><path d="M16 6h4v4"/></svg>
        </button>
        <button class="icon-btn danger" data-action="delete" title="Удалить сервер">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>
        </button>
      </div>`
    )
    .join('');

  $('#emptyServers').hidden = S.servers.length > 0;
  list.hidden = S.servers.length === 0;

  const pingBtn = $('#pingAll');
  pingBtn.disabled = pinging || S.servers.length === 0;
  pingBtn.lastChild.textContent = pinging ? ' Проверка…' : ' Проверить пинг';
}

function renderSubscriptions() {
  const list = $('#subList');
  if (!S.subscriptions.length) {
    list.innerHTML = `
      <div class="card empty" style="padding:34px 20px">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/></svg>
        </div>
        <h3>Подписок пока нет</h3>
        <p>Вставьте ссылку на подписку выше — серверы появятся автоматически.</p>
      </div>`;
    return;
  }
  list.innerHTML = S.subscriptions
    .map(
      (sub) => `
      <div class="row-card sub" data-id="${sub.id}">
        <div class="row-main">
          <div class="row-title">${esc(sub.name)}</div>
          <div class="row-sub">${esc(sub.url)}</div>
        </div>
        <span class="badge">${sub.count} серв.</span>
        <span class="row-sub">${new Date(sub.updatedAt).toLocaleString('ru-RU')}</span>
        <button class="btn small" data-action="update">
          <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2 6"/><path d="M20 5v6h-6"/></svg>
          Обновить
        </button>
        <button class="icon-btn danger" data-action="delete" title="Удалить подписку">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>
        </button>
      </div>`
    )
    .join('');
}

function renderRouting() {
  const settings = S.settings;
  $$('input[name="splitMode"]').forEach((input) => {
    input.checked = input.value === settings.splitMode;
  });

  $('#bypassRu').checked = Boolean(settings.bypassRu);
  $('#bypassLan').checked = Boolean(settings.bypassLan);
  $('#blockAds').checked = Boolean(settings.blockAds);

  const apps = settings.splitProcesses || [];
  $('#appList').innerHTML = apps.length
    ? apps
        .map(
          (app) => `<span class="chip">${esc(app)}<button data-app="${esc(app)}" title="Убрать">×</button></span>`
        )
        .join('')
    : '<span class="muted" style="font-size:12px">Список пуст — добавьте .exe</span>';

  $('#appsCard').style.opacity = settings.splitMode === 'all' ? '0.62' : '1';
  $('#appsHint').textContent =
    settings.splitMode === 'all'
      ? 'Список не используется в режиме «Весь трафик».'
      : 'Список используется в режиме «' + splitModeLabel(settings.splitMode) + '».';

  if (!domainsDirty) {
    if (document.activeElement !== $('#proxyDomains')) $('#proxyDomains').value = settings.proxyDomains || '';
    if (document.activeElement !== $('#directDomains')) $('#directDomains').value = settings.directDomains || '';
  }
}

function renderSettings() {
  $('#launchAtLogin').checked = Boolean(S.settings.launchAtLogin);
  $('#closeToTray').checked = Boolean(S.settings.closeToTray);
  $('#startMinimized').checked = Boolean(S.settings.startMinimized);
  $('#coreVersion').textContent = S.core.version ? `v${S.core.version}` : 'не найдено';
  $('#corePath').textContent = S.core.dir;
}

function renderLogs() {
  if (logInitialized) return;
  const view = $('#logView');
  view.innerHTML = '';
  for (const line of S.logs || []) appendLog(line, false);
  logInitialized = true;
  view.scrollTop = view.scrollHeight;
}

function appendLog(line, scroll = true) {
  const view = $('#logView');
  if (!view) return;
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const div = document.createElement('div');
  div.className = 'log-line';
  if (/\b(error|fatal|failed|denied)\b/i.test(line)) div.classList.add('error');
  else if (/\b(warn|warning|deprecated)\b/i.test(line)) div.classList.add('warn');
  div.textContent = line;
  view.appendChild(div);
  while (view.childElementCount > 500) view.removeChild(view.firstChild);
  if (scroll && atBottom) view.scrollTop = view.scrollHeight;
}

/* ---------------- traffic ---------------- */

function updateTraffic(data) {
  const [downValue, downUnit] = formatRate(data.down);
  const [upValue, upUnit] = formatRate(data.up);
  $('#speedDown').textContent = downValue;
  $('#unitDown').textContent = downUnit;
  $('#speedUp').textContent = upValue;
  $('#unitUp').textContent = upUnit;
  $('#totalDown').textContent = formatBytes(data.totalDown);
  $('#totalUp').textContent = formatBytes(data.totalUp);

  history.down.push(data.down || 0);
  history.up.push(data.up || 0);
  if (history.down.length > 60) history.down.shift();
  if (history.up.length > 60) history.up.shift();
  drawSpark();
}

function drawSpark() {
  const canvas = $('#spark');
  if (!canvas || !canvas.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = 72;
  if (canvas.width !== Math.floor(width * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = (height / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const max = Math.max(4096, ...history.down, ...history.up);
  const step = width / (history.down.length - 1);

  const drawSeries = (values, color, fillTop) => {
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = index * step;
      const y = height - Math.max(1, (value / max) * (height - 8));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, fillTop);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  };

  drawSeries(history.down, '#22d3ee', 'rgba(34,211,238,0.22)');
  drawSeries(history.up, '#a78bfa', 'rgba(167,139,250,0.18)');
}

/* ---------------- modal ---------------- */

function openModal({ title, text = '', placeholder = '', value = '', multiline = false, ok = 'Добавить', input = true }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalText').hidden = !text;
    const inputEl = $('#modalInput');
    const area = $('#modalArea');
    inputEl.hidden = !input || multiline;
    area.hidden = !input || !multiline;
    inputEl.value = multiline ? '' : value;
    area.value = multiline ? value : '';
    inputEl.placeholder = placeholder;
    area.placeholder = placeholder;
    $('#modalOk').textContent = ok;
    $('#modal').hidden = false;
    if (input) setTimeout(() => (multiline ? area : inputEl).focus(), 40);
  });
}

function closeModal(result) {
  $('#modal').hidden = true;
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(result);
  }
}

function modalValue() {
  if ($('#modalInput').hidden && $('#modalArea').hidden) return '';
  return $('#modalArea').hidden ? $('#modalInput').value.trim() : $('#modalArea').value.trim();
}

/* ---------------- events ---------------- */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('.nav-item');
    if (nav) {
      showPage(nav.dataset.page);
      return;
    }
    const link = event.target.closest('[data-page-link]');
    if (link) {
      showPage(link.dataset.pageLink);
      return;
    }
  });

  $('#winMin').addEventListener('click', () => api.window.minimize());
  $('#winMax').addEventListener('click', () => api.window.maximize());
  $('#winClose').addEventListener('click', () => api.window.close());

  $('#connectBtn').addEventListener('click', async () => {
    if (!S) return;
    if (S.connection.status === 'connected') {
      await guard(() => api.disconnect());
      return;
    }
    if (S.connection.status === 'connecting') return;
    if (!S.servers.length) {
      toast('Сначала добавьте сервер или подписку', 'error');
      showPage('subs');
      return;
    }
    const result = await guard(() => api.connect());
    if (result?.elevated) toast('Перезапуск с правами администратора…');
    else if (result?.error) toast(result.error, 'error');
  });

  $('#serverSearch').addEventListener('input', renderServers);

  $('#serverList').addEventListener('click', async (event) => {
    const row = event.target.closest('.row-card');
    if (!row) return;
    const id = row.dataset.id;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete') {
      const confirmed = await openModal({
        title: 'Удалить сервер?',
        text: 'Сервер будет удалён из списка. Подписку можно обновить позже.',
        ok: 'Удалить',
        input: false,
      });
      if (confirmed !== null) await guard(() => api.deleteServer(id), 'Сервер удалён');
      return;
    }
    if (action === 'ping') {
      await guard(() => api.testLatency(id));
      return;
    }
    if (action === 'select' || !action) {
      await guard(() => api.selectServer(id));
    }
  });

  $('#pingAll').addEventListener('click', async () => {
    if (pinging) return;
    pinging = true;
    renderServers();
    await guard(() => api.testLatency());
    pinging = false;
    renderServers();
  });

  $('#addLinkBtn').addEventListener('click', async () => {
    const link = await openModal({
      title: 'Добавить сервер по ссылке',
      text: 'Вставьте ссылку вида vless://, vmess://, trojan://, ss://, hysteria2://, tuic:// или anytls://.',
      placeholder: 'vless://uuid@host:443?...#Название',
      multiline: true,
    });
    if (!link) return;
    const server = await guard(() => api.addLink(link));
    if (server) toast(`Сервер «${server.name}» добавлен`, 'success');
  });

  $('#subAdd').addEventListener('click', async () => {
    const url = $('#subUrl').value.trim();
    const name = $('#subName').value.trim();
    if (!url) {
      toast('Укажите ссылку на подписку', 'error');
      return;
    }
    const button = $('#subAdd');
    button.disabled = true;
    const result = await guard(() => api.addSubscription(url, name));
    button.disabled = false;
    if (result) {
      $('#subUrl').value = '';
      $('#subName').value = '';
      toast(`Импортировано серверов: ${result.count}`, 'success');
      if (result.warnings?.length) toast(result.warnings[0], 'error');
    }
  });

  $('#subList').addEventListener('click', async (event) => {
    const row = event.target.closest('.row-card');
    if (!row) return;
    const id = row.dataset.id;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'update') {
      const result = await guard(() => api.updateSubscription(id));
      if (result) toast(`Обновлено серверов: ${result.count}`, 'success');
    } else if (action === 'delete') {
      const confirmed = await openModal({
        title: 'Удалить подписку?',
        text: 'Вместе с ней удалятся все импортированные серверы.',
        ok: 'Удалить',
        input: false,
      });
      if (confirmed !== null) await guard(() => api.removeSubscription(id), 'Подписка удалена');
    }
  });

  $('#modeGrid').addEventListener('change', (event) => {
    const input = event.target.closest('input[name="splitMode"]');
    if (!input) return;
    guard(() => api.setSettings({ splitMode: input.value }));
  });

  $('#appList').addEventListener('click', (event) => {
    const app = event.target.closest('[data-app]')?.dataset.app;
    if (!app) return;
    const next = (S.settings.splitProcesses || []).filter((item) => item !== app);
    guard(() => api.setSettings({ splitProcesses: next }));
  });

  $('#addApp').addEventListener('click', async () => {
    const file = await guard(() => api.pickExe());
    if (!file) return;
    const apps = S.settings.splitProcesses || [];
    if (apps.some((item) => item.toLowerCase() === file.name.toLowerCase())) {
      toast('Это приложение уже добавлено', 'error');
      return;
    }
    await guard(() => api.setSettings({ splitProcesses: [...apps, file.name] }));
  });

  $('#bypassRu').addEventListener('change', (event) => guard(() => api.setSettings({ bypassRu: event.target.checked })));
  $('#bypassLan').addEventListener('change', (event) => guard(() => api.setSettings({ bypassLan: event.target.checked })));
  $('#blockAds').addEventListener('change', (event) => guard(() => api.setSettings({ blockAds: event.target.checked })));

  $('#proxyDomains').addEventListener('input', () => (domainsDirty = true));
  $('#directDomains').addEventListener('input', () => (domainsDirty = true));

  $('#saveDomains').addEventListener('click', async () => {
    const proxyDomains = $('#proxyDomains').value.trim();
    const directDomains = $('#directDomains').value.trim();
    const result = await guard(() => api.setSettings({ proxyDomains, directDomains }));
    if (result) {
      domainsDirty = false;
      toast('Правила сохранены', 'success');
    }
  });

  $('#launchAtLogin').addEventListener('change', (event) =>
    guard(() => api.setSettings({ launchAtLogin: event.target.checked }))
  );
  $('#closeToTray').addEventListener('change', (event) =>
    guard(() => api.setSettings({ closeToTray: event.target.checked }))
  );
  $('#startMinimized').addEventListener('change', (event) =>
    guard(() => api.setSettings({ startMinimized: event.target.checked }))
  );

  $('#clearLogs').addEventListener('click', async () => {
    await guard(() => api.clearLogs());
    $('#logView').innerHTML = '';
    logInitialized = true;
  });

  $('#openCore').addEventListener('click', () => guard(() => api.openFolder()));
  $('#restartAdmin').addEventListener('click', () => guard(() => api.restartAdmin()));

  $('#modalCancel').addEventListener('click', () => closeModal(null));
  $('#modalOk').addEventListener('click', () => closeModal(modalValue()));
  $('#modal').addEventListener('mousedown', (event) => {
    if (event.target.id === 'modal') closeModal(null);
  });

  document.addEventListener('keydown', (event) => {
    if ($('#modal').hidden) return;
    if (event.key === 'Escape') closeModal(null);
    if (event.key === 'Enter' && !event.shiftKey) {
      if (event.target.id === 'modalInput' || (event.target.id === 'modalArea' && event.ctrlKey)) {
        event.preventDefault();
        closeModal(modalValue());
      }
    }
  });

  window.addEventListener('resize', drawSpark);
}

function showPage(name) {
  if (!PAGE_META[name]) return;
  currentPage = name;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  const [title, sub] = PAGE_META[name];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('.content').scrollTop = 0;
  if (name === 'home') drawSpark();
}

/* ---------------- timer / init ---------------- */

function tick() {
  if (!S) return;
  const timer = $('#sessionTimer');
  if (S.connection.status === 'connected' && S.connection.since) {
    const total = Math.max(0, Math.floor((Date.now() - S.connection.since) / 1000));
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    timer.textContent = `${hh}:${mm}:${ss}`;
  } else {
    timer.textContent = '00:00:00';
  }
}

async function init() {
  bindEvents();
  try {
    S = await api.getState();
  } catch (error) {
    toast(cleanError(error), 'error');
    return;
  }
  render();
  drawSpark();
  setInterval(tick, 1000);

  api.onState((next) => {
    S = next;
    render();
  });

  api.onTraffic((data) => updateTraffic(data));

  api.onLog((line) => appendLog(line));
}

init();
