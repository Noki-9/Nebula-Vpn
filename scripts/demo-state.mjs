// Заполняет состояние приложения демонстрационными серверами (для проверки интерфейса).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseUri } = require('../src/lib/parsers.js');

const uuid = '11111111-2222-3333-4444-555555555555';
const pbk = Buffer.alloc(32, 7).toString('base64url');
const ss = Buffer.from('aes-256-gcm:pass').toString('base64url');

const uris = [
  `vless://${uuid}@de1.example.com:443?security=reality&sni=www.microsoft.com&fp=chrome&pbk=${pbk}&sid=ab12&type=tcp&flow=xtls-rprx-vision#Германия • Frankfurt`,
  `vless://${uuid}@nl1.example.com:443?security=reality&sni=www.microsoft.com&fp=chrome&pbk=${pbk}&sid=ab12&type=tcp#Нидерланды • Amsterdam`,
  'trojan://pass@fi1.example.com:443?sni=fi1.example.com#Финляндия • Helsinki',
  `ss://${ss}@us1.example.com:8388#США • New York`,
  'hysteria2://pass@tr1.example.com:443?sni=tr1.example.com#Турция • Istanbul',
];

const servers = uris.map((uri) => {
  const server = parseUri(uri);
  if (!server) throw new Error(`Не разобрана ссылка: ${uri}`);
  return { ...server, subId: 'demo' };
});

const state = {
  subscriptions: [
    {
      id: 'demo',
      name: 'Моя подписка',
      url: 'https://example.com/sub/abc',
      updatedAt: Date.now(),
    },
  ],
  servers,
  selectedServerId: servers[0].id,
  settings: {
    splitMode: 'except',
    splitProcesses: ['chrome.exe', 'Telegram.exe'],
    bypassRu: true,
    bypassLan: true,
    blockAds: false,
    proxyDomains: 'youtube.com',
    directDomains: 'sberbank.ru',
    dnsRemote: 'https://1.1.1.1/dns-query',
    dnsDirect: '77.88.8.8',
    tunStack: 'mixed',
    mtu: 9000,
    autoConnect: false,
    launchAtLogin: false,
    closeToTray: true,
    startMinimized: false,
  },
  stats: { up: 123456789, down: 987654321 },
};

const dir = path.join(process.env.APPDATA || process.cwd(), 'NebulaVPN');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
console.log(`Демо-состояние записано: ${path.join(dir, 'state.json')}`);
