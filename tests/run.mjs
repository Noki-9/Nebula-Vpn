import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const { parseUri, parseSubscription } = require('../src/lib/parsers.js');
const { buildConfig } = require('../src/lib/config.js');

let passed = 0;
let failed = 0;

function ok(condition, label, extra) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${extra ? ` -> ${extra}` : ''}`);
  }
}

const uuid = '11111111-2222-3333-4444-555555555555';
const pbk = Buffer.alloc(32, 7).toString('base64url');

const samples = [
  {
    name: 'vless reality',
    uri: `vless://${uuid}@example.com:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&pbk=${pbk}&sid=ab12&type=tcp&flow=xtls-rprx-vision#Reality%20Test`,
    check: (s) => s.protocol === 'vless' && s.outbound.tls.reality.public_key === pbk && s.outbound.flow === 'xtls-rprx-vision',
  },
  {
    name: 'vless ws tls',
    uri: `vless://${uuid}@1.2.3.4:8443?encryption=none&security=tls&sni=cdn.example.com&type=ws&path=%2Fws&host=cdn.example.com&allowInsecure=1#WS`,
    check: (s) => s.outbound.transport.type === 'ws' && s.outbound.transport.path === '/ws' && s.outbound.tls.server_name === 'cdn.example.com',
  },
  {
    name: 'vmess ws',
    uri: `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'VM Test', add: '5.6.7.8', port: '443', id: uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'vm.example.com', path: '/vm', tls: 'tls', sni: 'vm.example.com' })).toString('base64')}`,
    check: (s) => s.protocol === 'vmess' && s.outbound.transport.type === 'ws' && s.outbound.tls.enabled === true,
  },
  {
    name: 'trojan grpc',
    uri: 'trojan://secret@trojan.example.com:443?sni=trojan.example.com&type=grpc&serviceName=grpcsvc#Trojan',
    check: (s) => s.outbound.password === 'secret' && s.outbound.transport.type === 'grpc',
  },
  {
    name: 'shadowsocks SIP002',
    uri: `ss://${Buffer.from('aes-256-gcm:pass:word').toString('base64url')}@ss.example.com:8388#SS`,
    check: (s) => s.outbound.method === 'aes-256-gcm' && s.outbound.password === 'pass:word',
  },
  {
    name: 'hysteria2',
    uri: 'hysteria2://letmein@hy.example.com:443?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=abc#HY2',
    check: (s) => s.protocol === 'hysteria2' && s.outbound.obfs.type === 'salamander',
  },
  {
    name: 'tuic',
    uri: `tuic://${uuid}:pass@tuic.example.com:443?sni=tuic.example.com&congestion_control=bbr#TUIC`,
    check: (s) => s.protocol === 'tuic' && s.outbound.uuid === uuid,
  },
  {
    name: 'anytls',
    uri: 'anytls://secret@any.example.com:443?sni=any.example.com#AnyTLS',
    check: (s) => s.protocol === 'anytls' && s.outbound.password === 'secret',
  },
];

console.log('\n== Парсер ссылок ==');
const parsed = [];
for (const sample of samples) {
  const server = parseUri(sample.uri);
  ok(Boolean(server), sample.name, 'не распознано');
  if (!server) continue;
  parsed.push(server);
  ok(sample.check(server), `${sample.name}: поля`, JSON.stringify(server.outbound));
}

console.log('\n== Подписка base64 ==');
const subText = Buffer.from(samples.map((s) => s.uri).join('\n')).toString('base64');
const sub = parseSubscription(subText);
ok(sub.servers.length === samples.length, `разобрано ${sub.servers.length}/${samples.length}`, sub.errors.join('; '));

console.log('\n== Подписка JSON (Xray) ==');
const xrayJson = JSON.stringify({
  outbounds: [
    {
      type: 'vless',
      tag: 'json-node',
      server: 'json.example.com',
      server_port: 443,
      uuid,
      tls: { enabled: true, server_name: 'json.example.com' },
      transport: { type: 'ws', path: '/json' },
    },
    { type: 'direct', tag: 'direct' },
  ],
});
const subJson = parseSubscription(xrayJson);
ok(subJson.servers.length === 1 && subJson.servers[0].name === 'json-node', 'JSON outbounds');

console.log('\n== sing-box check ==');
const dir = mkdtempSync(join(tmpdir(), 'nebula-test-'));
const cachePath = join(dir, 'cache.db');
const settings = {
  splitMode: 'except',
  splitProcesses: ['chrome.exe', 'C:\\Program Files\\Telegram\\Telegram.exe'],
  bypassRu: true,
  bypassLan: true,
  blockAds: true,
  proxyDomains: 'youtube.com, googlevideo.com',
  directDomains: 'sberbank.ru',
  dnsRemote: 'https://1.1.1.1/dns-query',
  dnsDirect: '77.88.8.8',
};

for (const server of parsed) {
  const config = buildConfig(server, settings, { cachePath, clashPort: 19090, rulesDir: join(root, 'core', 'rules') });
  const file = join(dir, `${server.protocol}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const res = spawnSync(join(root, 'core', 'sing-box.exe'), ['check', '-c', file], { encoding: 'utf8' });
  ok(res.status === 0, `config ${server.protocol}`, (res.stderr || res.stdout || '').trim());
}

console.log(`\nИтог: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
