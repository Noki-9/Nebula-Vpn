'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { clean } = require('./parsers');

const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set';
const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set';

const DEFAULTS = {
  splitMode: 'all',
  splitProcesses: [],
  bypassRu: true,
  bypassLan: true,
  blockAds: false,
  proxyDomains: '',
  directDomains: '',
  dnsRemote: 'https://1.1.1.1/dns-query',
  dnsDirect: '77.88.8.8',
  tunStack: 'mixed',
  mtu: 9000,
};

function splitDomains(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) =>
      item
        .replace(/^[a-z]+:\/\//, '')
        .split('/')[0]
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
    )
    .filter((item) => item.includes('.') || item === 'localhost');
}

function domainRule(domains, outbound) {
  return {
    domain: domains,
    domain_suffix: domains.map((d) => `.${d}`),
    action: 'route',
    outbound,
  };
}

function dnsDomainRule(domains, server) {
  return {
    domain: domains,
    domain_suffix: domains.map((d) => `.${d}`),
    server,
  };
}

function isIp(value) {
  return net.isIP(String(value || '').replace(/^\[|\]$/g, '')) !== 0;
}

function parseDnsServer(value, fallback) {
  const raw = String(value || fallback).trim();
  if (!raw) return { type: 'udp', server: fallback };
  if (!/^[a-z]+:\/\//i.test(raw)) {
    return { type: 'udp', server: raw };
  }
  try {
    const url = new URL(raw);
    const type = url.protocol === 'https:' ? 'https' : url.protocol === 'quic:' ? 'quic' : 'tls';
    return clean({
      type,
      server: url.hostname,
      server_port: url.port ? Number(url.port) : undefined,
      path: url.pathname && url.pathname !== '/' ? url.pathname : undefined,
    });
  } catch {
    return { type: 'udp', server: fallback };
  }
}

function ruleSet(tag, rulesDir) {
  if (rulesDir) {
    const local = path.join(rulesDir, `${tag}.srs`);
    if (fs.existsSync(local)) return { type: 'local', tag, format: 'binary', path: local };
  }
  const isGeoIp = tag.startsWith('geoip-');
  return {
    type: 'remote',
    tag,
    format: 'binary',
    url: `${isGeoIp ? GEOIP_BASE : GEOSITE_BASE}/${tag}.srs`,
    download_detour: 'direct',
    update_interval: '3d',
  };
}

function processName(value) {
  return String(value || '')
    .trim()
    .replace(/^.*[\\/]/, '');
}

/**
 * Собирает конфигурацию sing-box.
 * @param {object} server выбранный сервер
 * @param {object} settings настройки приложения
 * @param {{cachePath?: string, clashPort?: number, logLevel?: string}} options
 */
function buildConfig(server, settings, options = {}) {
  const s = { ...DEFAULTS, ...(settings || {}) };
  if (!server || !server.outbound) throw new Error('Сервер не выбран');

  const proxy = clean({ ...server.outbound, tag: 'proxy' });
  if (!isIp(proxy.server)) proxy.domain_resolver = 'dns-direct';

  const processes = [...new Set((s.splitProcesses || []).map(processName).filter(Boolean))];
  const customProxy = splitDomains(s.proxyDomains);
  const customDirect = splitDomains(s.directDomains);
  const bypassRu = Boolean(s.bypassRu);

  const ruleSetList = [];
  const rules = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }];

  if (customProxy.length) rules.push(domainRule(customProxy, 'proxy'));
  if (s.blockAds) {
    ruleSetList.push(ruleSet('geosite-category-ads-all', options.rulesDir));
    rules.push({ rule_set: ['geosite-category-ads-all'], action: 'reject' });
  }
  if (customDirect.length) rules.push(domainRule(customDirect, 'direct'));
  if (s.bypassLan) rules.push({ ip_is_private: true, action: 'route', outbound: 'direct' });

  if (bypassRu) {
    ruleSetList.push(ruleSet('geosite-category-ru', options.rulesDir), ruleSet('geoip-ru', options.rulesDir));
    rules.push({ rule_set: ['geosite-category-ru'], action: 'route', outbound: 'direct' });
    rules.push({ rule_set: ['geoip-ru'], action: 'route', outbound: 'direct' });
  }

  if (s.splitMode === 'only' && processes.length) {
    rules.push({ process_name: processes, action: 'route', outbound: 'proxy' });
  }
  if (s.splitMode === 'except' && processes.length) {
    rules.push({ process_name: processes, action: 'route', outbound: 'direct' });
  }

  const final = s.splitMode === 'only' ? 'direct' : 'proxy';

  const directDns = { ...parseDnsServer(s.dnsDirect, '77.88.8.8'), tag: 'dns-direct', detour: 'direct' };
  const remoteDns = { ...parseDnsServer(s.dnsRemote, '1.1.1.1'), tag: 'dns-remote', detour: 'proxy' };
  if (!isIp(remoteDns.server)) remoteDns.domain_resolver = 'dns-direct';

  const dns = {
    servers: [clean(directDns), clean(remoteDns)],
    rules: [],
    final: 'dns-remote',
    strategy: 'prefer_ipv4',
  };

  if (customDirect.length) dns.rules.push(dnsDomainRule(customDirect, 'dns-direct'));
  if (bypassRu) dns.rules.push({ rule_set: ['geosite-category-ru'], server: 'dns-direct' });
  if (s.blockAds) dns.rules.push({ rule_set: ['geosite-category-ads-all'], action: 'reject' });

  if (s.splitMode === 'only' && processes.length) {
    dns.rules.push({ process_name: processes, server: 'dns-remote' });
    dns.final = 'dns-direct';
  } else if (s.splitMode === 'except' && processes.length) {
    dns.rules.push({ process_name: processes, server: 'dns-direct' });
    dns.final = 'dns-remote';
  }

  const config = {
    log: {
      level: options.logLevel || 'info',
      timestamp: true,
    },
    dns,
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: Number(s.mtu) || 9000,
        auto_route: true,
        strict_route: true,
        stack: s.tunStack || 'mixed',
      },
    ],
    outbounds: [proxy, { type: 'direct', tag: 'direct' }],
    route: {
      rules,
      rule_set: ruleSetList,
      final,
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
    },
    experimental: clean({
      clash_api: {
        external_controller: `127.0.0.1:${options.clashPort || 9090}`,
        default_mode: 'rule',
      },
      cache_file: options.cachePath
        ? {
            enabled: true,
            path: options.cachePath,
          }
        : undefined,
    }),
  };

  return clean(config);
}

module.exports = { buildConfig, splitDomains, DEFAULTS, processName };
