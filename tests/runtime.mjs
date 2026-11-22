import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const { Core } = require('../src/lib/core.js');

const dir = mkdtempSync(join(tmpdir(), 'nebula-runtime-'));
const clashPort = 19091;
const proxyPort = 18080;
let failed = 0;

function ok(condition, label, extra) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && extra ? ` -> ${extra}` : ''}`);
  if (!condition) failed++;
}

const config = {
  log: { level: 'info', timestamp: true },
  inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: proxyPort }],
  outbounds: [{ type: 'direct', tag: 'proxy' }],
  experimental: { clash_api: { external_controller: `127.0.0.1:${clashPort}` } },
};

const core = new Core({
  coreDir: join(root, 'core'),
  configPath: join(dir, 'config.json'),
  clashPort,
});

core.on('log', (line) => {
  if (/error|fatal|warn/i.test(line)) console.log(`  [core] ${line}`);
});

console.log('\n== Запуск ядра ==');
ok(core.available, 'sing-box.exe найден');
ok(Boolean(core.version), `версия ${core.version}`);

core.prepare(config);
const checkError = core.check();
ok(!checkError, 'sing-box check', checkError);

await core.start();
ok(core.ready, 'ядро готово, clash API отвечает');

function proxyRequest(url) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
        headers: { Host: target.host },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const status = await proxyRequest('http://example.com/');
ok(status === 200 || status === 301 || status === 302, `HTTP-прокси работает (статус ${status})`);

const delay = await core.delay('proxy', 'http://www.gstatic.com/generate_204', 6000);
ok(typeof delay === 'number' && delay >= 0, `clash API delay = ${delay} мс`);

await new Promise((resolve) => setTimeout(resolve, 1200));
await core.stop();
ok(!core.child, 'ядро остановлено');

console.log(`\nИтог: ${failed ? `${failed} fail` : 'все проверки пройдены'}\n`);
process.exit(failed ? 1 : 0);
