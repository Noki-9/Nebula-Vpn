'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, extra) {
  if (!isPlainObject(extra)) return base;
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = merge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.load();
  }

  load() {
    const base = structuredClone(this.defaults);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return merge(base, raw);
    } catch {
      return base;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Не удалось сохранить состояние:', err.message);
    }
  }
}

module.exports = { Store };
