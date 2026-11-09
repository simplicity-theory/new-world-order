import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import GeoJSONVT from 'geojson-vt';
import { CHUNK, GEN_VERSION } from './gen/chunk.ts';
import { hashString } from './gen/rng.ts';
import { THREADS, run } from './pool.ts';

// One SQLite file per world. Chunks are frozen once written; every generation and
// save is timed and logged so the cost of growing a world can be studied later.

// DATA_DIR lets tests keep their worlds away from the real ones.
const DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data', 'worlds');
mkdirSync(DIR, { recursive: true });

/** Chunk indices covered by a world, inclusive. Worlds are always rectangles. */
export interface Bounds { x0: number; x1: number; y0: number; y1: number }
export type Side = 'n' | 'e' | 's' | 'w';
export interface WorldMeta {
  id: string; name: string; seed: string; created: string;
  origin: [number, number];
  bounds: Bounds | null;
  gen?: number;             // generator version the world was made with
  radius?: number;          // legacy: square worlds from before directional expansion
}
interface Job { done: number; total: number }
const MAX_INDEXES = 500;
export const MAX_TILES = 4000;

export class World {
  meta: WorldMeta;
  db: DatabaseSync;
  job: Job | null = null;
  tileCache = new Map<string, Buffer | null>();
  private indexes = new Map<string, GeoJSONVT | null>();

  constructor(db: DatabaseSync, meta: WorldMeta) {
    this.db = db;
    this.meta = meta;
    if (!meta.bounds && meta.radius !== undefined && meta.radius >= 0) {
      meta.bounds = { x0: -meta.radius, x1: meta.radius, y0: -meta.radius, y1: meta.radius };
    }
  }

  get seedNumber(): number { return hashString(this.meta.seed); }

  saveMeta(): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('world', JSON.stringify(this.meta));
  }

  /** Extent in Web Mercator metres around the origin, plus size in kilometres. */
  info() {
    const b = this.meta.bounds ?? { x0: 0, x1: 0, y0: 0, y1: 0 };
    const boundsM = { minx: (b.x0 - 0.5) * CHUNK, miny: (b.y0 - 0.5) * CHUNK, maxx: (b.x1 + 0.5) * CHUNK, maxy: (b.y1 + 0.5) * CHUNK };
    const chunks = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
    return {
      ...this.meta, version: chunks, stale: (this.meta.gen ?? 1) !== GEN_VERSION, chunkKm: CHUNK / 1000, boundsM,
      widthKm: (boundsM.maxx - boundsM.minx) / 1000, heightKm: (boundsM.maxy - boundsM.miny) / 1000, job: this.job,
    };
  }

  /** Vector tile index for one chunk; `lo` is the overview copy used at low zoom. */
  index(cx: number, cy: number, lo: boolean): GeoJSONVT | null {
    const key = `${cx},${cy},${lo ? 1 : 0}`;
    let idx = this.indexes.get(key);
    if (idx !== undefined) return idx;
    const row = this.db.prepare(`SELECT ${lo ? 'overview' : 'data'} AS d FROM chunks WHERE cx = ? AND cy = ?`).get(cx, cy) as { d: string } | undefined;
    idx = row
      ? new GeoJSONVT({ type: 'FeatureCollection', features: JSON.parse(row.d) } as never, { maxZoom: lo ? 11 : 16, tolerance: 2, buffer: 64 })
      : null;
    this.indexes.set(key, idx);
    // Keep memory bounded: drop the index that was built longest ago.
    if (this.indexes.size > MAX_INDEXES) this.indexes.delete(this.indexes.keys().next().value!);
    return idx;
  }

  /** Grow the world by `km` on the given sides, generating the missing chunks on the worker threads. */
  async expand(km: number, sides: Side[]): Promise<object> {
    if (this.job) throw new Error('already expanding');
    const old = this.meta.bounds;
    const n = Math.max(1, Math.ceil((km * 1000) / CHUNK));
    const next: Bounds = old
      ? { x0: old.x0 - (sides.includes('w') ? n : 0), x1: old.x1 + (sides.includes('e') ? n : 0),
          y0: old.y0 - (sides.includes('s') ? n : 0), y1: old.y1 + (sides.includes('n') ? n : 0) }
      : { x0: 0, x1: 0, y0: 0, y1: 0 };
    const todo: [number, number][] = [];
    for (let cy = next.y0; cy <= next.y1; cy++) {
      for (let cx = next.x0; cx <= next.x1; cx++) {
        if (!old || cx < old.x0 || cx > old.x1 || cy < old.y0 || cy > old.y1) todo.push([cx, cy]);
      }
    }
    // Hand each worker a contiguous arc of the new land, so neighbouring chunks share its caches.
    const mx = (next.x0 + next.x1) / 2, my = (next.y0 + next.y1) / 2;
    todo.sort((p, q) => Math.atan2(p[1] - my, p[0] - mx) - Math.atan2(q[1] - my, q[0] - mx));
    const threads = Math.min(THREADS, todo.length);
    this.job = { done: 0, total: todo.length };
    const started = performance.now();
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO chunks (cx, cy, expansion, generated_at, gen_ms, serialize_ms, save_ms, stages, features, bytes, data, overview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const patch = this.db.prepare('UPDATE chunks SET save_ms = ? WHERE cx = ? AND cy = ?');
    const expId = Number(this.db.prepare(
      'INSERT INTO expansions (started_at, km, sides, threads, chunks) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), km, old ? sides.join('') : 'start', threads, todo.length).lastInsertRowid);
    const sum = { gen: 0, serialize: 0, save: 0, features: 0, bytes: 0 };
    const stages: Record<string, number> = {};
    try {
      await Promise.all(todo.map(async ([cx, cy], k) => {
        const r = await run({ type: 'chunk', seed: this.seedNumber, origin: this.meta.origin, cx, cy }, Math.floor((k * threads) / todo.length));
        const t0 = performance.now();
        const bytes = Buffer.byteLength(r.data) + Buffer.byteLength(r.overview);
        insert.run(cx, cy, expId, new Date().toISOString(), r.genMs, r.serializeMs, 0, JSON.stringify(r.timings), r.features, bytes, r.data, r.overview);
        const saveMs = performance.now() - t0;
        patch.run(saveMs, cx, cy);
        sum.gen += r.genMs; sum.serialize += r.serializeMs; sum.save += saveMs;
        sum.features += r.features; sum.bytes += bytes;
        for (const [name, v] of Object.entries(r.timings as Record<string, number>)) stages[name] = (stages[name] ?? 0) + v;
        this.job!.done++;
      }));
    } finally {
      this.job = null;
    }
    this.meta.bounds = next;
    this.saveMeta();
    this.db.prepare('UPDATE expansions SET gen_ms = ?, serialize_ms = ?, save_ms = ?, total_ms = ?, features = ?, bytes = ?, stages = ? WHERE id = ?')
      .run(sum.gen, sum.serialize, sum.save, performance.now() - started, sum.features, sum.bytes, JSON.stringify(stages), expId);
    this.tileCache.clear();
    return fmtExpansion(this.db.prepare('SELECT * FROM expansions WHERE id = ?').get(expId) as Record<string, unknown>);
  }

  stats() {
    const expansions = (this.db.prepare('SELECT * FROM expansions WHERE total_ms IS NOT NULL ORDER BY id').all() as Record<string, unknown>[]).map(fmtExpansion);
    const totals = this.db.prepare(
      'SELECT COUNT(*) AS chunks, SUM(gen_ms) AS gen_ms, SUM(serialize_ms) AS serialize_ms, SUM(save_ms) AS save_ms, SUM(features) AS features, SUM(bytes) AS bytes, MAX(gen_ms) AS slowest_chunk_ms FROM chunks').get() as Record<string, number>;
    const dem = this.db.prepare('SELECT COUNT(*) AS tiles, SUM(ms) AS ms, MAX(ms) AS slowest_ms, SUM(LENGTH(png)) AS bytes FROM dem_tiles').get() as Record<string, number>;
    const areaKm2 = totals.chunks * (CHUNK / 1000) ** 2;
    return {
      world: this.info(),
      threads: THREADS,
      totals: { ...round(totals), area_km2: areaKm2, gen_ms_per_km2: r2(totals.gen_ms / areaKm2), bytes_per_km2: Math.round(totals.bytes / areaKm2) },
      elevation_tiles: round(dem),
      expansions,
    };
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
function round<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? r2(v) : v;
  return out as T;
}
function fmtExpansion(row: Record<string, unknown>): object {
  const stages = row.stages ? round(JSON.parse(row.stages as string)) : {};
  return round({ ...row, stages });
}

const open = new Map<string, World>();

function connect(id: string): DatabaseSync {
  const db = new DatabaseSync(join(DIR, `${id}.sqlite`));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (
      cx INTEGER NOT NULL, cy INTEGER NOT NULL, expansion INTEGER, generated_at TEXT,
      gen_ms REAL, serialize_ms REAL, save_ms REAL, stages TEXT, features INTEGER, bytes INTEGER,
      data TEXT NOT NULL, overview TEXT NOT NULL, PRIMARY KEY (cx, cy));
    CREATE TABLE IF NOT EXISTS expansions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, km REAL, radius_before INTEGER, radius_after INTEGER,
      chunks INTEGER, gen_ms REAL, serialize_ms REAL, save_ms REAL, total_ms REAL, features INTEGER, bytes INTEGER, stages TEXT);
    CREATE TABLE IF NOT EXISTS dem_tiles (z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, ms REAL, png BLOB NOT NULL, PRIMARY KEY (z, x, y));
  `);
  // Columns added after the first version; older world files gain them on open.
  for (const col of ['sides TEXT', 'threads INTEGER']) {
    try { db.exec(`ALTER TABLE expansions ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  return db;
}

export function listWorlds(): WorldMeta[] {
  const out: WorldMeta[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.sqlite')) continue;
    const w = getWorld(f.slice(0, -7));
    if (w) out.push(w.meta);
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export function getWorld(id: string): World | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  let w = open.get(id);
  if (w) return w;
  if (!readdirSync(DIR).includes(`${id}.sqlite`)) return null;
  const db = connect(id);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('world') as { value: string } | undefined;
  if (!row) { db.close(); return null; }
  w = new World(db, JSON.parse(row.value));
  open.set(id, w);
  return w;
}

export async function createWorld(name: string, seed: string): Promise<World> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'world';
  const id = `${slug}-${Date.now().toString(36)}`;
  const { origin } = await run({ type: 'origin', seed: hashString(seed), origin: null });
  const meta: WorldMeta = { id, name, seed, created: new Date().toISOString(), origin, bounds: null, gen: GEN_VERSION };
  const w = new World(connect(id), meta);
  w.saveMeta();
  open.set(id, w);
  await w.expand(0, []);
  return w;
}

export function deleteWorld(id: string): boolean {
  const w = getWorld(id);
  if (!w) return false;
  w.db.close();
  open.delete(id);
  for (const ext of ['', '-wal', '-shm']) rmSync(join(DIR, `${id}.sqlite${ext}`), { force: true });
  return true;
}
