/**
 * Loads the SQLite runtime used by every other module.
 *
 * - Browser: the vendored `vendor/sql-wasm.js` (SQLite compiled to
 *   WebAssembly) is loaded as a classic script; it exposes `initSqlJs`
 *   globally. Nothing is fetched from a CDN.
 * - Node: the `sql.js` package is imported directly.
 */

const VENDOR_SCRIPT = new URL('../../vendor/sql-wasm.js', import.meta.url).href;
const VENDOR_DIR = new URL('../../vendor/', import.meta.url).href;

const isBrowser = () => typeof document !== 'undefined';

let runtimePromise = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(script);
  });
}

async function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (globalThis.initSqlJs) return globalThis.initSqlJs;
    if (isBrowser()) {
      await injectScript(VENDOR_SCRIPT);
      if (!globalThis.initSqlJs) throw new Error('vendor/sql-wasm.js did not expose initSqlJs');
      return globalThis.initSqlJs;
    }
    const mod = await import('sql.js'); // Node (or any bundler resolving node_modules)
    return mod.default ?? mod;
  })();
  return runtimePromise;
}

let sqlitePromise = null;

/** Returns the initialised sql.js module (`{ Database, ... }`). */
export function getSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = loadRuntime().then((init) =>
      init(isBrowser() ? { locateFile: (file) => VENDOR_DIR + file } : {}),
    );
  }
  return sqlitePromise;
}

/** Opens a database from bytes (a copy is made), or an empty one when omitted. */
export async function openDatabase(bytes) {
  const { Database } = await getSqlite();
  return new Database(bytes);
}
