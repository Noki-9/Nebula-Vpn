'use strict';

const { execFileSync, spawn } = require('node:child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'NebulaVPN';

let adminCache = null;

function isAdmin() {
  if (adminCache !== null) return adminCache;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    adminCache = true;
  } catch {
    adminCache = false;
  }
  return adminCache;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Перезапускает приложение с правами администратора (UAC). */
function relaunchElevated(app, extraArgs = []) {
  const exe = process.execPath;
  const args = app.isPackaged ? [...extraArgs] : [app.getAppPath(), ...extraArgs];
  const quoted = args.map((arg) => psQuote(`"${arg}"`));
  const script = [
    `$exe = ${psQuote(exe)}`,
    `$arguments = @(${quoted.join(', ')})`,
    'Start-Process -FilePath $exe -ArgumentList $arguments -Verb RunAs',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
}

function autostartCommand(app) {
  const parts = [`"${process.execPath}"`];
  if (!app.isPackaged) parts.push(`"${app.getAppPath()}"`);
  parts.push('--autostart');
  return parts.join(' ');
}

function setAutostart(app, enabled) {
  try {
    if (enabled) {
      execFileSync(
        'reg',
        ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', autostartCommand(app), '/f'],
        { windowsHide: true, stdio: 'ignore' }
      );
    } else {
      execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    }
    return true;
  } catch {
    return false;
  }
}

function isAutostartEnabled() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes(RUN_VALUE);
  } catch {
    return false;
  }
}

module.exports = { isAdmin, relaunchElevated, setAutostart, isAutostartEnabled };
