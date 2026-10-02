/**
 * Loads the SQLite runtime used by every other module.
 *
 * - Browser: the vendored `vendor/sql-wasm.js` (SQLite compiled to
 *   WebAssembly) is loaded as a classic script; it exposes `initSqlJs`
 *   globally. Nothing is fetched from a CDN.
 * - Node: the `sql.js` package is imported directly.
 */

import type { Database as SqlJsDatabase } from 'sql.js';

/**
 * Vendored assets are resolved against the page URL, not the module path, so
 * the browser bundle can be emitted anywhere (page root, subpath, dist/...).
 */
const vendorUrl = (path: string): string => new URL(`vendor/${path}`, document.baseURI).href;

declare global {
  // eslint-disable-next-line no-var
  var initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic> | undefined;
}

type InitSqlJs = (config?: SqlJsConfig) => Promise<SqlJsStatic>;

const isBrowser = (): boolean => typeof document !== 'undefined';

let runtimePromise: Promise<InitSqlJs> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(script);
  });
}

async function loadRuntime(): Promise<InitSqlJs> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (globalThis.initSqlJs) return globalThis.initSqlJs as InitSqlJs;
    if (isBrowser()) {
      try {
        await injectScript(vendorUrl('sql-wasm.js'));
      } catch (loadError) {
        throw new Error(
          `failed to load vendor/sql-wasm.js: ${loadError?.message ?? String(loadError)}. ` +
            'If the file is missing, serving it from the same directory as index.html usually fixes this.',
        );
      }
      if (!globalThis.initSqlJs) {
        throw new Error(
          'vendor/sql-wasm.js loaded but did not expose initSqlJs. ' +
            'This can happen if the vendored file is outdated or was replaced by a different build.',
        );
      }
      return globalThis.initSqlJs as InitSqlJs;
    }
    const mod = await import('sql.js'); // Node (or any bundler resolving node_modules)
    if (!mod || (!('default' in mod) && typeof mod.initSqlJs !== 'function')) {
      throw new Error('sql.js did not export an initSqlJs entry point');
    }
    return (mod.default ?? mod) as InitSqlJs;
  })();
  return runtimePromise;
}

let sqlitePromise: Promise<{ Database: typeof SqlJsDatabase }> | null = null;

/** Returns the initialised sql.js module (`{ Database, ... }`). */
export function getSqlite(): Promise<{ Database: typeof SqlJsDatabase }> {
  if (!sqlitePromise) {
    sqlitePromise = loadRuntime().then(
      (init) =>
        init(isBrowser() ? { locateFile: (file: string) => vendorUrl(file) } : {}),
    );
  }
  return sqlitePromise;
}

/** Opens a database from bytes (a copy is made), or an empty one when omitted. */
export async function openDatabase(bytes?: Uint8Array): Promise<SqlJsDatabase> {
  const { Database } = await getSqlite();
  return new Database(bytes);
}
