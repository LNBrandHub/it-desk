/**
 * Minimal Google Apps Script + Google Sheets emulator for testing Code.gs offline.
 * It deliberately reproduces the platform quirks that break real deployments:
 *  - google.script.run cannot return Date objects (the call comes back null/fails)
 *  - Sheets auto-converts typed values (date-like strings -> Date, numeric strings -> number,
 *    "=..." -> formula) unless the cell has plain-text format "@"
 *  - Functions whose name ends in "_" are NOT callable from the browser
 *  - CacheService values are strings, 6-hour max TTL
 *  - Lock contention
 * Not part of the deployed app. Used only by tests/run-tests.js.
 */
const crypto = require('crypto');
const vm = require('vm');

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.formats = {}; this.formulaWrites = 0; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getDataRange() { return this.getRange(1, 1, this.rows.length || 1, this.getLastColumn() || 1); }
  appendRow(arr) { this.rows.push(arr.map(v => this._coerce(v, undefined))); }
  _coerce(v, fmt) {
    if (fmt === '@') return v instanceof Date ? v : (typeof v === 'boolean' ? v : String(v));
    if (typeof v === 'string') {
      if (/^=/.test(v)) { this.formulaWrites++; return { __formula: v }; }
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00Z');
      if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
      if (/^\d+e\d+$/i.test(v)) return Number(v);
    }
    return v;
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) {
            const v = (sh.rows[r - 1 + i] || [])[c - 1 + j];
            row.push(v === undefined ? '' : (v && v.__formula ? v.__formula : v));
          }
          out.push(row);
        }
        return out;
      },
      setValues(vals) {
        vals.forEach((rv, i) => {
          while (sh.rows.length < r + i) sh.rows.push([]);
          const row = sh.rows[r - 1 + i];
          rv.forEach((v, j) => { row[c - 1 + j] = sh._coerce(v, sh.formats[(r + i) + ':' + (c + j)]); });
        });
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      setNumberFormats(f) {
        f.forEach((rv, i) => rv.forEach((fmt, j) => { sh.formats[(r + i) + ':' + (c + j)] = fmt; }));
        return this;
      },
      setNumberFormat(fmt) {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.formats[(r + i) + ':' + (c + j)] = fmt;
        return this;
      },
    };
  }
}

function makeEnv(opts = {}) {
  const sheets = {};
  const props = {};
  const cache = {};
  const lockState = { held: false };
  const env = { sheets, props, cache, sentinel: {}, now: () => new Date() };

  const Spreadsheet = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
  };
  const sandbox = {
    console,
    SpreadsheetApp: { openById: id => { if (id !== 'TEST_DB') throw new Error('bad id'); return Spreadsheet; } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => { const e = cache[k]; return e && e.exp > Date.now() ? e.v : null; },
        put: (k, v, ttl) => { if (typeof v !== 'string') throw new Error('cache needs string'); if (ttl > 21600) throw new Error('ttl too long'); cache[k] = { v, exp: Date.now() + ttl * 1000 }; },
        remove: k => { delete cache[k]; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (lockState.held) throw new Error('Lock timeout'); lockState.held = true; env.lockAcquired = (env.lockAcquired || 0) + 1; },
        releaseLock() { lockState.held = false; },
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, str) => Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, fmt) => {
        const p = n => String(n).padStart(2, '0');
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return fmt.replace('yyyy', d.getFullYear()).replace('MMM', M[d.getMonth()]).replace('MM', p(d.getMonth() + 1))
          .replace('dd', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds()));
      },
    },
    Session: { getScriptTimeZone: () => 'Africa/Lagos' },
    HtmlService: { createHtmlOutputFromFile: n => ({ setTitle() { return this; }, addMetaTag() { return this; }, __file: n }) },
  };
  vm.createContext(sandbox);
  env.sandbox = sandbox;
  env.load = (src, file = 'Code.gs') => {
    // top-level const/let are not exposed on the context object, so hoist them for lookup
    vm.runInContext(src, sandbox, { filename: file });
    vm.runInContext('this.__CONFIG = typeof CONFIG !== "undefined" ? CONFIG : null', sandbox);
  };

  /**
   * Emulates google.script.run.fn(...args) from the browser:
   *  - private functions (trailing underscore) are not callable
   *  - return values go through structured serialisation: Dates / functions => failure
   */
  env.run = async (fn, ...args) => {
    if (/_$/.test(fn)) throw new Error('google.script.run: ' + fn + ' is not a function');
    const f = vm.runInContext('typeof ' + fn + ' === "function" ? ' + fn + ' : undefined', sandbox);
    if (!f) throw new Error('google.script.run: ' + fn + ' is not a function');
    const clonedArgs = JSON.parse(JSON.stringify(args === undefined ? [] : args));
    const result = f.apply(null, clonedArgs);
    assertSerialisable(result, fn);
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  };
  return env;
}

function assertSerialisable(v, fn, path = 'result') {
  if (v instanceof Date) throw new Error(`[serialisation] ${fn}: ${path} is a Date; google.script.run returns null for the whole call`);
  if (typeof v === 'function') throw new Error(`[serialisation] ${fn}: ${path} is a function`);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) assertSerialisable(v[k], fn, path + '.' + k);
}

module.exports = { makeEnv };
