'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Core extends EventEmitter {
  constructor({ coreDir, configPath, clashPort = 9090 }) {
    super();
    this.coreDir = coreDir;
    this.configPath = configPath;
    this.clashPort = clashPort;
    this.child = null;
    this.stopping = false;
    this.logs = [];
    this.statsReq = null;
    this.ready = false;
    this._version = undefined;
  }

  get binaryPath() {
    return path.join(this.coreDir, 'sing-box.exe');
  }

  get available() {
    return fs.existsSync(this.binaryPath);
  }

  get version() {
    if (this._version !== undefined) return this._version;
    if (!this.available) return null;
    try {
      const res = spawnSync(this.binaryPath, ['version'], { encoding: 'utf8', timeout: 5000 });
      const match = /sing-box version ([^\s]+)/.exec(res.stdout || '');
      this._version = match ? match[1] : null;
    } catch {
      this._version = null;
    }
    return this._version;
  }

  log(line) {
    const text = String(line).replace(/\r$/, '');
    if (!text.trim()) return;
    this.logs.push(text);
    if (this.logs.length > 400) this.logs.shift();
    this.emit('log', text);
  }

  prepare(config) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  check() {
    const res = spawnSync(this.binaryPath, ['check', '-c', this.configPath], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: this.coreDir,
    });
    if (res.status === 0) return null;
    return (res.stderr || res.stdout || 'Неизвестная ошибка конфигурации').trim();
  }

  async start() {
    if (this.child) await this.stop();
    this.stopping = false;
    this.ready = false;

    const child = spawn(this.binaryPath, ['run', '-c', this.configPath], {
      cwd: this.coreDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const onData = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) this.log(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      this.log(`Ошибка запуска ядра: ${err.message}`);
      this.emit('exit', { code: -1, error: err.message, unexpected: !this.stopping });
    });

    child.on('exit', (code, signal) => {
      const unexpected = !this.stopping;
      this.child = null;
      this.ready = false;
      this._stopStats();
      if (unexpected) this.log(`Ядро завершилось (код ${code ?? signal})`);
      this.emit('exit', { code, signal, unexpected });
    });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('Ядро завершилось при запуске. Проверьте журнал.');
      if (await this._ping()) {
        this.ready = true;
        this._startStats();
        return;
      }
      await sleep(250);
    }
    await this.stop();
    throw new Error('Ядро не ответило за 20 секунд. Проверьте журнал.');
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    this._stopStats();
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await sleep(150);
  }

  _ping() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.clashPort, path: '/version', timeout: 700 },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }

  _startStats() {
    this._stopStats();
    const req = http.get(
      { host: '127.0.0.1', port: this.clashPort, path: '/traffic', timeout: 0 },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
              const data = JSON.parse(line);
              this.emit('traffic', { up: Number(data.up) || 0, down: Number(data.down) || 0 });
            } catch {
              /* ignore malformed */
            }
          }
        });
        res.on('end', () => {
          if (this.child && !this.stopping) setTimeout(() => this.ready && this._startStats(), 1500);
        });
      }
    );
    req.on('error', () => {
      if (this.child && !this.stopping) setTimeout(() => this.ready && this._startStats(), 1500);
    });
    this.statsReq = req;
  }

  _stopStats() {
    if (this.statsReq) {
      try {
        this.statsReq.destroy();
      } catch {
        /* ignore */
      }
      this.statsReq = null;
    }
  }

  /** Реальная задержка через прокси (clash API). */
  delay(tag = 'proxy', url = 'http://www.gstatic.com/generate_204', timeout = 5000) {
    return new Promise((resolve) => {
      const target = `/proxies/${encodeURIComponent(tag)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`;
      const req = http.get({ host: '127.0.0.1', port: this.clashPort, path: target, timeout: timeout + 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(typeof data.delay === 'number' ? data.delay : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });
  }
}

module.exports = { Core };
