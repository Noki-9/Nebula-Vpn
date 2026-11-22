// Загружает актуальное ядро sing-box и наборы правил в папку core/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'core');
const rulesDir = path.join(coreDir, 'rules');
fs.mkdirSync(rulesDir, { recursive: true });

const UA = { 'User-Agent': 'NebulaVPN/1.0' };

async function download(url, file) {
  const response = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} для ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, buffer);
  return buffer.length;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractZip(zip, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(destination)} -Force`,
    ],
    { stdio: 'inherit' }
  );
}

console.log('→ Проверяем последнюю версию sing-box…');
const release = await fetch('https://api.github.com/repos/SagerNet/sing-box/releases/latest', {
  headers: UA,
}).then((response) => {
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  return response.json();
});

const asset = release.assets.find(
  (item) => item.name.includes('windows-amd64') && item.name.endsWith('.zip') && !item.name.includes('legacy')
);
if (!asset) throw new Error('Не найден архив sing-box для Windows amd64');

const tempZip = path.join(os.tmpdir(), asset.name);
console.log(`→ Скачиваем ${asset.name}…`);
const size = await download(asset.browser_download_url, tempZip);
console.log(`  ${(size / 1024 / 1024).toFixed(1)} МБ`);

const tempDir = path.join(os.tmpdir(), 'nebula-core-extract');
extractZip(tempZip, tempDir);

const extracted = fs.readdirSync(tempDir).find((name) => fs.statSync(path.join(tempDir, name)).isDirectory());
const sourceDir = path.join(tempDir, extracted || '');
for (const name of fs.readdirSync(sourceDir)) {
  fs.copyFileSync(path.join(sourceDir, name), path.join(coreDir, name));
}
console.log(`→ sing-box ${release.tag_name.replace(/^v/, '')} установлен в core/`);

console.log('→ Обновляем наборы правил…');
const ruleSets = [
  ['https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs', 'geosite-category-ru.srs'],
  ['https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs', 'geoip-ru.srs'],
  [
    'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs',
    'geosite-category-ads-all.srs',
  ],
];
for (const [url, name] of ruleSets) {
  const bytes = await download(url, path.join(rulesDir, name));
  console.log(`  ${name} (${(bytes / 1024).toFixed(0)} КБ)`);
}

const wintun = path.join(coreDir, 'wintun.dll');
if (fs.existsSync(wintun)) {
  console.log('→ wintun.dll уже на месте');
} else {
  console.log('\n! wintun.dll не найден. TUN-режим не запустится.');
  console.log('  Скачайте wintun 0.14.1 с https://www.wintun.net/ и положите');
  console.log('  wintun.dll (bin/amd64) рядом с sing-box.exe в папку core/.');
}

fs.rmSync(tempZip, { force: true });
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('\nГотово.');
