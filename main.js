'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');

const { Store } = require('./src/lib/store');
const { parseUri, parseSubscription } = require('./src/lib/parsers');
const { buildConfig, DEFAULTS: ROUTING_DEFAULTS } = require('./src/lib/config');
const { Core } = require('./src/lib/core');
const { isAdmin, relaunchElevated, setAutostart } = require('./src/lib/win');

app.setName('NebulaVPN');

const ROUTING_KEYS = new Set([
  'splitMode',
  'splitProcesses',
  'bypassRu',
  'bypassLan',
  'blockAds',
  'proxyDomains',
  'directDomains',
  'dnsRemote',
  'dnsDirect',
  'mtu',
  'tunStack',
]);

const DEFAULT_STATE = {
  subscriptions: [],
  servers: [],
  selectedServerId: null,
  settings: {
    ...ROUTING_DEFAULTS,
    autoConnect: false,
    launchAtLogin: false,
    closeToTray: true,
    startMinimized: false,
  },
  stats: { up: 0, down: 0 },
};

let win = null;
let tray = null;
let quitting = false;
let store = null;
let state = null;
let core = null;
let connection = { status: 'disconnected', serverId: null, since: null, error: null };
let latency = new Map();
let reconnectTimer = null;
let lastSave = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function coreDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'core') : path.join(__dirname, 'core');
}

function publicState() {
  return {
    servers: state.servers.map((server) => ({
      id: server.id,
      name: server.name,
      protocol: server.protocol,
      host: server.host,
      port: server.port,
      subId: server.subId || null,
      latency: latency.has(server.id) ? latency.get(server.id) : null,
    })),
    subscriptions: state.subscriptions.map((sub) => ({
      id: sub.id,
      name: sub.name,
      url: sub.url,
      updatedAt: sub.updatedAt,
      count: state.servers.filter((server) => server.subId === sub.id).length,
    })),
    selectedServerId: state.selectedServerId,
    settings: state.settings,
    connection: { ...connection },
    stats: {
      up: 0,
      down: 0,
      totalUp: state.stats.up || 0,
      totalDown: state.stats.down || 0,
      since: connection.since,
    },
    admin: isAdmin(),
    core: {
      available: core ? core.available : false,
      version: core ? core.version : null,
      dir: core ? core.coreDir : coreDir(),
      path: core ? core.binaryPath : null,
    },
    logs: core ? core.logs.slice(-300) : [],
    appVersion: app.getVersion(),
  };
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function pushState() {
  broadcast('state', publicState());
  updateTray();
}

function saveState() {
  if (store) store.save();
  lastSave = Date.now();
}

function selectedServer() {
  return state.servers.find((server) => server.id === state.selectedServerId) || null;
}

function setConnection(next) {
  connection = { ...connection, ...next };
  pushState();
}

function statusLabel() {
  if (connection.status === 'connected') return 'Защищено';
  if (connection.status === 'connecting') return 'Подключение…';
  if (connection.status === 'error') return 'Ошибка';
  return 'Отключено';
}

function updateTray() {
  if (!tray) return;
  const connected = connection.status === 'connected';
  tray.setToolTip(`Nebula VPN — ${statusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Nebula VPN — ${statusLabel()}`, enabled: false },
      { type: 'separator' },
      {
        label: connected ? 'Отключить' : 'Подключить',
        click: () => (connected ? disconnect() : connect()),
      },
      {
        label: 'Открыть окно',
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => app.quit(),
      },
    ])
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#080a0f',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.argv.includes('--smoke')) {
    const smokeDir = process.env.NEBULA_SMOKE_DIR || __dirname;
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
    win.webContents.on('did-fail-load', (event, code, description) => {
      console.log(`SMOKE FAIL ${code} ${description}`);
      quitting = true;
      app.exit(1);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const info = await win.webContents.executeJavaScript(
          `({ title: document.title, pages: document.querySelectorAll('.page').length, cards: document.querySelectorAll('.card').length, nav: document.querySelectorAll('.nav-item').length, servers: document.querySelectorAll('#serverList .row-card').length })`
        );
        console.log(`SMOKE ${JSON.stringify(info)}`);
        await new Promise((resolve) => setTimeout(resolve, 900));
        for (const page of ['home', 'servers', 'subs', 'routing', 'logs', 'settings']) {
          await win.webContents.executeJavaScript(`showPage(${JSON.stringify(page)})`);
          await new Promise((resolve) => setTimeout(resolve, 450));
          const shot = await win.webContents.capturePage();
          fs.writeFileSync(path.join(smokeDir, `smoke-${page}.png`), shot.toPNG());
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(smokeDir, 'smoke.png'), image.toPNG());
        setTimeout(() => {
          quitting = true;
          app.exit(0);
        }, 1500);
      } catch (error) {
        console.log(`SMOKE ERROR ${error.message}`);
        quitting = true;
        app.exit(1);
      }
    });
  }

  win.once('ready-to-show', () => {
    if (!(process.argv.includes('--autostart') && state.settings.startMinimized)) win.show();
  });

  win.on('close', (event) => {
    if (!quitting && state.settings.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(image);
  tray.on('click', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.show();
  });
  updateTray();
}

function tcpPing(host, port, timeout = 3500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(Date.now() - started));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
    try {
      socket.connect(Number(port), host);
    } catch {
      finish(null);
    }
  });
}

async function testLatency(id) {
  const targets = id
    ? state.servers.filter((server) => server.id === id)
    : [...state.servers];

  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(8, targets.length) }, async () => {
    while (index < targets.length) {
      const server = targets[index++];
      let value = null;
      if (connection.status === 'connected' && server.id === state.selectedServerId) {
        value = await core.delay('proxy');
      }
      if (value === null) value = await tcpPing(server.host, server.port);
      latency.set(server.id, value);
      results.push({ id: server.id, latency: value });
    }
  });
  await Promise.all(workers);
  pushState();
  return results;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(9090));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchSubscription(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NebulaVPN/1.0 (sing-box; Windows)',
        Accept: '*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Сервер ответил HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Истекло время ожидания (25 с)');
    throw new Error(error.message || 'Не удалось загрузить подписку');
  } finally {
    clearTimeout(timer);
  }
}

async function addSubscription(url, name) {
  const trimmed = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Укажите ссылку, начинающуюся с http:// или https://');
  const text = await fetchSubscription(trimmed);
  const parsed = parseSubscription(text);
  if (!parsed.servers.length) {
    throw new Error(parsed.errors[0] || 'В подписке не найдено поддерживаемых серверов');
  }
  const id = crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 10);
  const servers = parsed.servers.map((server) => ({ ...server, subId: id }));

  state.servers = state.servers.filter((server) => server.subId !== id);
  state.servers.push(...servers);

  const existing = state.subscriptions.find((sub) => sub.id === id);
  const subscription = {
    id,
    name: String(name || '').trim() || existing?.name || `Подписка ${state.subscriptions.length + 1}`,
    url: trimmed,
    updatedAt: Date.now(),
  };
  if (existing) Object.assign(existing, subscription);
  else state.subscriptions.push(subscription);

  if (!selectedServer()) {
    state.selectedServerId = servers[0]?.id || null;
    if (connection.status === 'connected') await disconnect();
  }
  saveState();
  pushState();
  testLatency();
  return { count: servers.length, warnings: parsed.errors, subscription };
}

async function updateSubscription(id) {
  const subscription = state.subscriptions.find((sub) => sub.id === id);
  if (!subscription) throw new Error('Подписка не найдена');
  return addSubscription(subscription.url, subscription.name);
}

async function removeSubscription(id) {
  const connectedToSub =
    connection.status === 'connected' &&
    state.servers.some((server) => server.id === connection.serverId && server.subId === id);
  state.subscriptions = state.subscriptions.filter((sub) => sub.id !== id);
  state.servers = state.servers.filter((server) => server.subId !== id);
  if (connectedToSub) await disconnect();
  if (!selectedServer()) state.selectedServerId = state.servers[0]?.id || null;
  saveState();
  pushState();
}

function addLink(link) {
  const server = parseUri(link);
  if (!server) throw new Error('Не удалось разобрать ссылку. Поддерживаются vless://, vmess://, trojan://, ss://, hysteria2://, tuic://, anytls://');
  server.subId = null;
  const existing = state.servers.find((item) => item.id === server.id);
  if (!existing) state.servers.push(server);
  if (!state.selectedServerId) state.selectedServerId = server.id;
  saveState();
  pushState();
  return server;
}

async function connect() {
  if (connection.status === 'connected' || connection.status === 'connecting') return { ok: true };

  if (!isAdmin()) {
    relaunchElevated(app, ['--autoconnect']);
    setTimeout(() => app.quit(), 1200);
    return { ok: false, elevated: true };
  }

  const server = selectedServer();
  if (!server) {
    setConnection({ status: 'error', error: 'Сначала выберите сервер', since: null });
    return { ok: false, error: 'Сначала выберите сервер' };
  }
  if (!core.available) {
    setConnection({ status: 'error', error: 'Ядро sing-box не найдено. Запустите npm run core:fetch', since: null });
    return { ok: false, error: 'Ядро не найдено' };
  }

  setConnection({ status: 'connecting', serverId: server.id, since: null, error: null });

  try {
    const port = await freePort();
    core.clashPort = port;
    const config = buildConfig(server, state.settings, {
      cachePath: path.join(app.getPath('userData'), 'runtime', 'cache.db'),
      clashPort: port,
      rulesDir: path.join(core.coreDir, 'rules'),
    });
    core.prepare(config);
    const configError = core.check();
    if (configError) throw new Error(`Ошибка конфигурации: ${configError}`);

    await core.start();
    setConnection({ status: 'connected', serverId: server.id, since: Date.now(), error: null });
    setTimeout(async () => {
      if (connection.status !== 'connected') return;
      const value = await core.delay('proxy');
      if (value !== null) {
        latency.set(server.id, value);
        pushState();
      }
    }, 1000);
    return { ok: true };
  } catch (error) {
    await core.stop();
    setConnection({ status: 'error', error: error.message, since: null });
    return { ok: false, error: error.message };
  }
}

async function disconnect() {
  await core.stop();
  setConnection({ status: 'disconnected', serverId: null, since: null, error: null });
  return { ok: true };
}

function scheduleReconnect() {
  if (connection.status !== 'connected') return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (connection.status !== 'connected') return;
    await disconnect();
    await connect();
  }, 900);
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('server:select', async (event, id) => {
    if (!state.servers.some((server) => server.id === id)) throw new Error('Сервер не найден');
    state.selectedServerId = id;
    saveState();
    pushState();
    if (connection.status === 'connected') {
      await disconnect();
      await connect();
    }
    return true;
  });

  ipcMain.handle('server:latency', async (event, id) => testLatency(id || null));
  ipcMain.handle('server:add', (event, { link }) => addLink(link));

  ipcMain.handle('server:delete', async (event, id) => {
    if (connection.serverId === id) await disconnect();
    state.servers = state.servers.filter((server) => server.id !== id);
    latency.delete(id);
    if (!selectedServer()) state.selectedServerId = state.servers[0]?.id || null;
    saveState();
    pushState();
    return true;
  });

  ipcMain.handle('sub:add', (event, { url, name }) => addSubscription(url, name));
  ipcMain.handle('sub:update', (event, id) => updateSubscription(id));
  ipcMain.handle('sub:remove', async (event, id) => {
    await removeSubscription(id);
    return true;
  });

  ipcMain.handle('settings:set', (event, patch) => {
    const before = { ...state.settings };
    state.settings = { ...state.settings, ...(patch || {}) };
    if ('launchAtLogin' in (patch || {})) {
      setAutostart(app, Boolean(state.settings.launchAtLogin));
    }
    saveState();
    pushState();
    const routingChanged = Object.keys(patch || {}).some((key) => ROUTING_KEYS.has(key) && before[key] !== state.settings[key]);
    if (routingChanged) scheduleReconnect();
    return state.settings;
  });

  ipcMain.handle('connect', () => connect());
  ipcMain.handle('disconnect', () => disconnect());

  ipcMain.handle('logs:clear', () => {
    if (core) core.logs = [];
    pushState();
    return true;
  });

  ipcMain.handle('core:open-folder', () => shell.openPath(core.coreDir));

  ipcMain.handle('dialog:pick-exe', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите приложение',
      properties: ['openFile'],
      filters: [{ name: 'Программы', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { name: path.basename(result.filePaths[0]), path: result.filePaths[0] };
  });

  ipcMain.handle('shell:open', (event, url) => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(url);
    return false;
  });

  ipcMain.handle('app:restart-admin', () => {
    relaunchElevated(app, ['--autoconnect']);
    setTimeout(() => app.quit(), 800);
    return true;
  });

  ipcMain.handle('window:minimize', () => win?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => win?.close());
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'), DEFAULT_STATE);
  state = store.data;
  if (!state.servers.some((server) => server.id === state.selectedServerId)) {
    state.selectedServerId = state.servers[0]?.id || null;
  }
  Menu.setApplicationMenu(null);

  core = new Core({
    coreDir: coreDir(),
    configPath: path.join(app.getPath('userData'), 'runtime', 'config.json'),
  });

  core.on('log', (line) => broadcast('log', line));
  core.on('traffic', ({ up, down }) => {
    state.stats.up = (state.stats.up || 0) + up;
    state.stats.down = (state.stats.down || 0) + down;
    broadcast('traffic', {
      up,
      down,
      totalUp: state.stats.up,
      totalDown: state.stats.down,
      since: connection.since,
    });
    if (Date.now() - lastSave > 30000) saveState();
  });
  core.on('exit', ({ unexpected }) => {
    if (!unexpected) return;
    setConnection({
      status: 'error',
      error: 'Соединение прервано. Откройте журнал, чтобы увидеть причину.',
      since: null,
    });
  });

  registerIpc();
  createWindow();
  createTray();
  pushState();

  if (process.argv.includes('--autoconnect')) {
    setTimeout(() => connect(), 1200);
  } else if (state.settings.autoConnect && isAdmin()) {
    setTimeout(() => connect(), 1500);
  }
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.race([core ? core.stop() : Promise.resolve(), sleep(3000)]).finally(() => {
    saveState();
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (!quitting) app.quit();
});

process.on('exit', () => {
  try {
    if (store) store.save();
  } catch {
    /* ignore */
  }
});
