/**
 * Supabase/PostgREST falso en memoria para tests de integración del pipeline.
 * Implementa el subconjunto del query builder que usa `src/db.js`.
 */

function parseOrFilter(expr) {
  // "a.is.null,b.not.is.null,seeders.eq.0,imdb_id.eq.\"\""
  return expr.split(',').map((part) => {
    const segs = part.split('.');
    const col = segs.shift();
    let negate = false;
    if (segs[0] === 'not') { negate = true; segs.shift(); }
    const op = segs.shift();
    let val = segs.join('.');
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return { col, op, val, negate };
  });
}

const coerce = (val) => {
  if (val === 'null') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val !== '' && !Number.isNaN(Number(val))) return Number(val);
  return val;
};

function evalCondition(row, { col, op, val, negate }) {
  const v = row[col];
  let res;
  switch (op) {
    case 'is': res = val === null ? v === null || v === undefined : v === val; break;
    case 'eq': res = v == val; break; // eslint-disable-line eqeqeq
    case 'gt': res = v !== null && v !== undefined && v > val; break;
    case 'lt': res = v !== null && v !== undefined && v < val; break;
    case 'in': res = val.includes(v); break;
    case 'imatch': res = typeof v === 'string' && new RegExp(val, 'i').test(v); break;
    default: throw new Error(`fakeSupabase: operador no soportado ${op}`);
  }
  return negate ? !res : res;
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.conds = [];
    this.ors = [];
    this.mode = 'select';
    this.columns = '*';
    this.opts = {};
    this.orderBy = null;
    this.limitN = null;
    this.patch = null;
  }
  select(columns = '*', opts = {}) { this.columns = columns; this.opts = opts; if (this.mode === 'select') this.mode = 'select'; return this; }
  order(col, { ascending = true } = {}) { this.orderBy = { col, ascending }; return this; }
  limit(n) { this.limitN = n; return this; }
  gt(col, val) { this.conds.push({ col, op: 'gt', val }); return this; }
  lt(col, val) { this.conds.push({ col, op: 'lt', val }); return this; }
  eq(col, val) { this.conds.push({ col, op: 'eq', val }); return this; }
  in(col, val) { this.conds.push({ col, op: 'in', val }); return this; }
  is(col, val) { this.conds.push({ col, op: 'is', val }); return this; }
  not(col, op, val) { this.conds.push({ col, op, val, negate: true }); return this; }
  filter(col, op, val) { this.conds.push({ col, op, val }); return this; }
  or(expr) { this.ors.push(parseOrFilter(expr).map((c) => ({ ...c, val: coerce(c.val) }))); return this; }
  delete(opts = {}) { this.mode = 'delete'; this.opts = opts; return this; }
  update(patch) { this.mode = 'update'; this.patch = patch; return this; }

  _matches(row) {
    return this.conds.every((c) => evalCondition(row, c)) && this.ors.every((group) => group.some((c) => evalCondition(row, c)));
  }

  _run() {
    const rows = this.store.tables[this.table];
    this.store.calls.push({ table: this.table, mode: this.mode });
    let matched = rows.filter((r) => this._matches(r));
    if (this.mode === 'delete') {
      const ids = new Set(matched.map((r) => r.id));
      this.store.tables[this.table] = rows.filter((r) => !ids.has(r.id));
      this.store.deleted.push(...ids);
      return { data: null, error: null, count: this.opts.count ? ids.size : null };
    }
    if (this.mode === 'update') {
      for (const r of matched) Object.assign(r, this.patch);
      this.store.updated.push(...matched.map((r) => r.id));
      return { data: null, error: null, count: matched.length };
    }
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      matched = [...matched].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
    }
    const total = matched.length;
    if (this.limitN !== null) matched = matched.slice(0, this.limitN);
    if (this.opts.head) return { data: null, error: null, count: total };
    const cols = this.columns === '*' ? null : this.columns.split(',').map((c) => c.trim());
    const data = matched.map((r) => {
      if (!cols) return { ...r };
      const out = {};
      for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
      return out;
    });
    return { data, error: null, count: this.opts.count ? total : null };
  }

  then(resolve, reject) {
    try { return Promise.resolve(this._run()).then(resolve, reject); } catch (err) { return Promise.reject(err).then(resolve, reject); }
  }
}

/**
 * Crea un cliente falso.
 * @param {object[]} rows filas iniciales de la tabla `torrents`
 * @param {{ rpc?: boolean }} opts rpc=true simula la función bulk_update_torrents
 */
export function createFakeSupabase(rows, { rpc = false } = {}) {
  const store = { tables: { torrents: rows.map((r) => ({ ...r })) }, calls: [], deleted: [], updated: [], rpcCalls: 0 };
  const client = {
    from: (table) => new Query(store, table),
    rpc: async (name, args) => {
      if (name !== 'bulk_update_torrents' || !rpc) {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
      }
      store.rpcCalls += 1;
      let n = 0;
      for (const { id, patch } of args.updates) {
        const row = store.tables.torrents.find((r) => String(r.id) === String(id));
        if (row) { Object.assign(row, patch); n += 1; store.updated.push(row.id); }
      }
      return { data: n, error: null };
    },
  };
  return { client, store };
}
