'use strict';

const crypto = require('node:crypto');

const PROTOCOL_LABEL = {
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

const SUPPORTED = new Set(Object.keys(PROTOCOL_LABEL));

/** Убирает undefined / null / пустые массивы и объекты. */
function clean(value) {
  if (Array.isArray(value)) {
    const arr = value.map(clean).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === null || value === '' || value === undefined) return undefined;
  return value;
}

function b64decode(input) {
  let s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function stripBrackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

function splitHostPort(value) {
  const v = String(value || '').trim();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return [v.slice(1, end), Number(v.slice(end + 2))];
  }
  const idx = v.lastIndexOf(':');
  if (idx < 0) return [v, NaN];
  return [v.slice(0, idx), Number(v.slice(idx + 1))];
}

function boolParam(value) {
  if (value === undefined || value === null) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function decodeName(hash) {
  if (!hash) return '';
  try {
    return decodeURIComponent(hash.replace(/^#/, '')).trim();
  } catch {
    return hash.replace(/^#/, '').trim();
  }
}

function safeUrl(uri) {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function buildTls(params, host, { force = false, reality = false } = {}) {
  const security = (params.get('security') || '').toLowerCase();
  if (!force && !reality && security !== 'tls' && security !== 'xtls') return undefined;
  const sni = params.get('sni') || params.get('peer') || params.get('host') || host;
  const alpn = params.get('alpn');
  const tls = {
    enabled: true,
    server_name: sni || undefined,
    insecure: boolParam(params.get('allowInsecure') ?? params.get('insecure')),
    alpn: alpn ? alpn.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    utls: {
      enabled: true,
      fingerprint: params.get('fp') || 'chrome',
    },
  };
  if (reality || security === 'reality') {
    tls.reality = {
      enabled: true,
      public_key: params.get('pbk') || params.get('publicKey') || undefined,
      short_id: params.get('sid') || params.get('shortId') || undefined,
    };
  }
  return clean(tls);
}

function buildTransport(params, host) {
  const type = (params.get('type') || params.get('net') || 'tcp').toLowerCase();
  const path = params.get('path') || '/';
  const headerHost = params.get('host') || params.get('sni') || host;
  switch (type) {
    case 'ws':
      return clean({
        type: 'ws',
        path,
        headers: headerHost ? { Host: headerHost } : undefined,
        max_early_data: params.get('ed') ? Number(params.get('ed')) : undefined,
        early_data_header_name: params.get('eh') || undefined,
      });
    case 'grpc':
      return clean({
        type: 'grpc',
        service_name: params.get('serviceName') || params.get('service_name') || '',
      });
    case 'http':
    case 'h2':
      return clean({
        type: 'http',
        host: headerHost ? headerHost.split(',').map((x) => x.trim()) : undefined,
        path,
      });
    case 'httpupgrade':
      return clean({ type: 'httpupgrade', host: headerHost, path });
    case 'quic':
      return { type: 'quic' };
    case 'tcp':
    case 'raw':
    case '':
      return undefined;
    default:
      return undefined;
  }
}

function hashOutbound(outbound) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(outbound))
    .digest('hex')
    .slice(0, 12);
}

function makeServer(outbound, name, extra = {}) {
  const o = clean({ ...outbound, tag: undefined });
  if (!o || !o.type || !o.server || !o.server_port) return null;
  return {
    id: hashOutbound(o),
    name: String(name || '').trim() || `${PROTOCOL_LABEL[o.type] || o.type} ${o.server}`,
    protocol: o.type,
    host: o.server,
    port: Number(o.server_port),
    outbound: o,
    ...extra,
  };
}

function parseVless(uri) {
  const u = safeUrl(uri);
  if (!u) return null;
  const p = u.searchParams;
  const outbound = {
    type: 'vless',
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username),
    flow: p.get('flow') || undefined,
    packet_encoding: p.get('packetEncoding') || p.get('packet_encoding') || undefined,
  };
  const tls = buildTls(p, outbound.server, { reality: (p.get('security') || '').toLowerCase() === 'reality' });
  if (tls) outbound.tls = tls;
  const transport = buildTransport(p, outbound.server);
  if (transport) outbound.transport = transport;
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseVmess(uri) {
  const hashIdx = uri.indexOf('#');
  const name = hashIdx >= 0 ? decodeName(uri.slice(hashIdx)) : '';
  const payload = uri.slice('vmess://'.length, hashIdx >= 0 ? hashIdx : undefined);
  const json = JSON.parse(b64decode(payload));
  const server = stripBrackets(String(json.add || '').trim());
  const port = Number(json.port);
  if (!server || !port) return null;
  const outbound = {
    type: 'vmess',
    server,
    server_port: port,
    uuid: json.id,
    security: json.scy || 'auto',
    alter_id: Number(json.aid || 0),
  };
  const net = String(json.net || 'tcp').toLowerCase();
  const headerHost = json.host || json.sni || server;
  if (net === 'ws') {
    outbound.transport = clean({
      type: 'ws',
      path: json.path || '/',
      headers: json.host ? { Host: json.host } : undefined,
    });
  } else if (net === 'grpc') {
    outbound.transport = clean({ type: 'grpc', service_name: json.path || '' });
  } else if (net === 'h2' || net === 'http') {
    outbound.transport = clean({
      type: 'http',
      host: json.host ? json.host.split(',').map((x) => x.trim()) : undefined,
      path: json.path || '/',
    });
  }
  if (String(json.tls || '').toLowerCase() === 'tls' || String(json.tls || '').toLowerCase() === 'reality') {
    const alpn = json.alpn ? String(json.alpn).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    outbound.tls = clean({
      enabled: true,
      server_name: json.sni || json.host || server,
      insecure: json.allowInsecure === true || json.allowInsecure === '1',
      alpn,
      utls: { enabled: true, fingerprint: json.fp || 'chrome' },
    });
  }
  return makeServer(outbound, name || json.ps, { raw: uri });
}

function parseTrojan(uri) {
  const u = safeUrl(uri);
  if (!u) return null;
  const p = u.searchParams;
  const outbound = {
    type: 'trojan',
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || 443),
    password: decodeURIComponent(u.username),
  };
  if ((p.get('security') || 'tls').toLowerCase() !== 'none') {
    outbound.tls = buildTls(p, outbound.server, { force: true });
  }
  const transport = buildTransport(p, outbound.server);
  if (transport) outbound.transport = transport;
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseShadowsocks(uri) {
  let body = uri.slice('ss://'.length);
  let name = '';
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    name = decodeName(body.slice(hashIdx));
    body = body.slice(0, hashIdx);
  }
  let query = '';
  const qIdx = body.indexOf('?');
  if (qIdx >= 0) {
    query = body.slice(qIdx + 1);
    body = body.slice(0, qIdx);
  }

  let method;
  let password;
  let host;
  let port;

  const at = body.lastIndexOf('@');
  if (at >= 0) {
    let userinfo = body.slice(0, at);
    const hostport = body.slice(at + 1);
    if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
    const colon = userinfo.indexOf(':');
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
    [host, port] = splitHostPort(hostport);
  } else {
    const decoded = b64decode(body);
    const at2 = decoded.lastIndexOf('@');
    if (at2 < 0) return null;
    const userinfo = decoded.slice(0, at2);
    const colon = userinfo.indexOf(':');
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
    [host, port] = splitHostPort(decoded.slice(at2 + 1));
  }
  if (!host || !port || !method) return null;

  const params = new URLSearchParams(query);
  const outbound = {
    type: 'shadowsocks',
    server: stripBrackets(host),
    server_port: Number(port),
    method,
    password,
  };
  const plugin = params.get('plugin');
  if (plugin) {
    const [pluginName, ...opts] = plugin.split(';');
    const map = { 'obfs-local': 'obfs-local', 'simple-obfs': 'obfs-local', 'v2ray-plugin': 'v2ray-plugin' };
    outbound.plugin = map[pluginName] || pluginName;
    outbound.plugin_opts = opts.join(';');
  }
  return makeServer(outbound, name, { raw: uri });
}

function parseHysteria2(uri) {
  const u = safeUrl(uri);
  if (!u) return null;
  const p = u.searchParams;
  const outbound = {
    type: 'hysteria2',
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || 443),
    password: decodeURIComponent(u.username) || decodeURIComponent(u.password || ''),
  };
  const obfs = p.get('obfs');
  if (obfs) outbound.obfs = clean({ type: obfs, password: p.get('obfs-password') || undefined });
  outbound.tls = clean({
    enabled: true,
    server_name: p.get('sni') || outbound.server,
    insecure: boolParam(p.get('insecure')),
    alpn: p.get('alpn') ? p.get('alpn').split(',').map((x) => x.trim()).filter(Boolean) : undefined,
  });
  if (p.get('upmbps')) outbound.up_mbps = Number(p.get('upmbps'));
  if (p.get('downmbps')) outbound.down_mbps = Number(p.get('downmbps'));
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseTuic(uri) {
  const u = safeUrl(uri);
  if (!u) return null;
  const p = u.searchParams;
  const outbound = {
    type: 'tuic',
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ''),
    congestion_control: p.get('congestion_control') || 'bbr',
    udp_relay_mode: p.get('udp_relay_mode') || 'native',
    tls: clean({
      enabled: true,
      server_name: p.get('sni') || outbound.server,
      insecure: boolParam(p.get('allow_insecure') ?? p.get('insecure')),
      alpn: p.get('alpn') ? p.get('alpn').split(',').map((x) => x.trim()).filter(Boolean) : ['h3'],
    }),
  };
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseAnyTLS(uri) {
  const u = safeUrl(uri);
  if (!u) return null;
  const p = u.searchParams;
  const outbound = {
    type: 'anytls',
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || 443),
    password: decodeURIComponent(u.username) || decodeURIComponent(u.password || ''),
    tls: clean({
      enabled: true,
      server_name: p.get('sni') || outbound.server,
      insecure: boolParam(p.get('insecure') ?? p.get('allowInsecure')),
      alpn: p.get('alpn') ? p.get('alpn').split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    }),
  };
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseSocksHttp(uri, type) {
  const u = safeUrl(uri);
  if (!u) return null;
  const outbound = {
    type,
    server: stripBrackets(u.hostname),
    server_port: Number(u.port || (type === 'socks' ? 1080 : 8080)),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
  return makeServer(outbound, decodeName(u.hash), { raw: uri });
}

function parseUri(raw) {
  const uri = String(raw || '').trim();
  const sep = uri.indexOf('://');
  if (sep < 0) return null;
  const scheme = uri.slice(0, sep).toLowerCase();
  switch (scheme) {
    case 'vless':
      return parseVless(uri);
    case 'vmess':
      return parseVmess(uri);
    case 'trojan':
      return parseTrojan(uri);
    case 'ss':
      return parseShadowsocks(uri);
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(uri);
    case 'tuic':
      return parseTuic(uri);
    case 'anytls':
      return parseAnyTLS(uri);
    case 'socks':
    case 'socks5':
      return parseSocksHttp(uri, 'socks');
    case 'http':
    case 'https':
      return parseSocksHttp(uri, 'http');
    default:
      return null;
  }
}

/** Конвертация outbound из формата Xray (streamSettings) в формат sing-box. */
function xrayToSingbox(o) {
  const out = {
    type: o.type,
    server: o.server,
    server_port: Number(o.port || o.server_port),
  };
  if (o.type === 'vless') {
    out.uuid = o.id || o.uuid;
    out.flow = o.flow || undefined;
  } else if (o.type === 'vmess') {
    out.uuid = o.id || o.uuid;
    out.security = o.security || 'auto';
    out.alter_id = Number(o.alterId || o.alter_id || 0);
  } else if (o.type === 'trojan') {
    out.password = o.password;
  } else if (o.type === 'shadowsocks') {
    out.method = o.method;
    out.password = o.password;
  } else if (o.type === 'hysteria2') {
    out.password = o.password;
  } else if (o.type === 'tuic') {
    out.uuid = o.uuid;
    out.password = o.password;
  } else if (o.type === 'anytls') {
    out.password = o.password;
  }

  const stream = o.streamSettings || o.stream_settings;
  if (stream) {
    const net = String(stream.network || 'tcp').toLowerCase();
    if (net === 'ws') {
      out.transport = clean({
        type: 'ws',
        path: stream.wsSettings?.path || '/',
        headers: stream.wsSettings?.headers,
      });
    } else if (net === 'grpc') {
      out.transport = clean({ type: 'grpc', service_name: stream.grpcSettings?.serviceName || '' });
    } else if (net === 'http' || net === 'h2') {
      out.transport = clean({
        type: 'http',
        host: stream.httpSettings?.host,
        path: stream.httpSettings?.path,
      });
    } else if (net === 'httpupgrade') {
      out.transport = clean({
        type: 'httpupgrade',
        host: stream.httpupgradeSettings?.host,
        path: stream.httpupgradeSettings?.path,
      });
    }

    const security = String(stream.security || '').toLowerCase();
    if (security === 'tls' || security === 'reality') {
      const tls = stream.tlsSettings || {};
      const reality = stream.realitySettings || {};
      out.tls = clean({
        enabled: true,
        server_name: tls.serverName || reality.serverName,
        insecure: tls.allowInsecure === true,
        alpn: tls.alpn,
        utls: {
          enabled: true,
          fingerprint: reality.fingerprint || tls.fingerprint || 'chrome',
        },
        reality:
          security === 'reality'
            ? {
                enabled: true,
                public_key: reality.publicKey,
                short_id: reality.shortId,
              }
            : undefined,
      });
    }
  }
  return clean(out);
}

function fromJsonConfig(obj) {
  let outbounds = null;
  if (Array.isArray(obj)) outbounds = obj;
  else if (obj && Array.isArray(obj.outbounds)) outbounds = obj.outbounds;
  if (!outbounds) return [];

  const servers = [];
  const seen = new Set();
  for (const o of outbounds) {
    if (!o || typeof o !== 'object' || !SUPPORTED.has(o.type)) continue;
    if (o.tag && /^(direct|block|dns|bypass|freedom)/i.test(String(o.tag))) continue;
    let outbound;
    if (o.server_port !== undefined) {
      outbound = clean({ ...o, tag: undefined });
    } else {
      outbound = xrayToSingbox(o);
    }
    const server = makeServer(outbound, o.tag || `${PROTOCOL_LABEL[o.type]} ${outbound.server}`, {
      raw: JSON.stringify(o),
    });
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
  }
  return servers;
}

/**
 * Разбирает содержимое подписки: список URI, base64 или JSON-конфиг.
 * @returns {{servers: Array, errors: string[]}}
 */
function parseSubscription(text) {
  const errors = [];
  let content = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!content) return { servers: [], errors: ['Пустой ответ от сервера подписки'] };

  if (content.startsWith('{') || content.startsWith('[')) {
    try {
      const servers = fromJsonConfig(JSON.parse(content));
      if (servers.length) return { servers, errors };
    } catch (err) {
      errors.push(`JSON: ${err.message}`);
    }
  }

  let lines = content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!lines.some((line) => line.includes('://'))) {
    const decoded = b64decode(content);
    if (decoded.includes('://')) {
      lines = decoded
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const servers = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.includes('://')) continue;
    try {
      const server = parseUri(line);
      if (server && !seen.has(server.id)) {
        seen.add(server.id);
        servers.push(server);
      }
    } catch (err) {
      errors.push(`Ссылка пропущена: ${err.message}`);
    }
  }
  return { servers, errors };
}

module.exports = {
  PROTOCOL_LABEL,
  SUPPORTED,
  parseUri,
  parseSubscription,
  xrayToSingbox,
  makeServer,
  clean,
};
