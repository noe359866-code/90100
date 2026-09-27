/**
 * Logger minimalista con niveles y soporte para los "groups" de GitHub Actions.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const IS_GHA = process.env.GITHUB_ACTIONS === 'true';

let currentLevel = LEVELS.info;

const ts = () => new Date().toISOString();

/** Las anotaciones de Actions rompen el comando si hay saltos de línea o `%`. */
const ghaEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const fmt = (args) =>
  args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');

export const log = {
  setLevel(level) {
    currentLevel = LEVELS[level] ?? LEVELS.info;
  },
  debug: (...args) => {
    if (currentLevel <= LEVELS.debug) console.log(`${ts()} [DEBUG] ${fmt(args)}`);
  },
  info: (...args) => {
    if (currentLevel <= LEVELS.info) console.log(`${ts()} [INFO ] ${fmt(args)}`);
  },
  warn: (...args) => {
    if (currentLevel <= LEVELS.warn) {
      console.warn(`${ts()} [WARN ] ${fmt(args)}`);
      if (IS_GHA) console.log(`::warning::${ghaEscape(fmt(args))}`);
    }
  },
  error: (...args) => {
    if (currentLevel <= LEVELS.error) {
      console.error(`${ts()} [ERROR] ${fmt(args)}`);
      if (IS_GHA) console.log(`::error::${ghaEscape(fmt(args))}`);
    }
  },
  /** Agrupa la salida en GitHub Actions (plegable en la UI). */
  group: (title) => {
    if (IS_GHA) console.log(`::group::${title}`);
    else console.log(`\n=== ${title} ===`);
  },
  groupEnd: () => {
    if (IS_GHA) console.log('::endgroup::');
  },
};
