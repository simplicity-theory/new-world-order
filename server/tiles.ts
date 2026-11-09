import { crc32, deflateSync } from 'node:zlib';
import vtpbf from 'vt-pbf';
import { CHUNK } from './gen/chunk.ts';
import { run } from './pool.ts';
import { MAX_TILES, type World } from './store.ts';

const HALF_WORLD = Math.PI * 6378137;
const LO_MAX_ZOOM = 11;     // at or below this zoom, tiles come from the overview copy
export const MAX_ZOOM = 16;
const DETAIL_MIN_ZOOM = 13; // fine detail is left out of tiles below this zoom

/** Detail that is stored with a chunk but only worth sending at high zoom. */
function isDetail(tags: { layer: string; kind: string }): boolean {
  switch (tags.layer) {
    case 'building': case 'field': case 'poi': case 'manmade': case 'ford': case 'crossing': return true;
    case 'contour': return tags.kind !== 'index';
    case 'river': return tags.kind === 'stream';
    case 'road': return tags.kind === 'track';
    default: return false;
  }
}

/** Build one vector tile by merging the per-chunk tile indexes that overlap it. */
export function getTile(world: World, z: number, x: number, y: number): Buffer | null {
  const key = `${z}/${x}/${y}`;
  const cached = world.tileCache.get(key);
  if (cached !== undefined) return cached;
  let out: Buffer | null = null;
  const b = world.meta.bounds;
  if (b && z >= 0 && z <= MAX_ZOOM) {
    const size = (2 * HALF_WORLD) / 2 ** z;
    const pad = size * 0.03;
    // World-local metres are Web Mercator metres, so tile bounds map straight to chunks.
    const minx = -HALF_WORLD + x * size - pad, maxx = -HALF_WORLD + (x + 1) * size + pad;
    const maxy = HALF_WORLD - y * size + pad, miny = HALF_WORLD - (y + 1) * size - pad;
    const c0 = Math.max(b.x0, Math.floor(minx / CHUNK + 0.5)), c1 = Math.min(b.x1, Math.floor(maxx / CHUNK + 0.5));
    const d0 = Math.max(b.y0, Math.floor(miny / CHUNK + 0.5)), d1 = Math.min(b.y1, Math.floor(maxy / CHUNK + 0.5));
    const layers: Record<string, { features: unknown[] }> = {};
    const lo = z <= LO_MAX_ZOOM;
    for (let cy = d0; cy <= d1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const tile = world.index(cx, cy, lo)?.getTile(z, x, y);
        if (!tile) continue;
        for (const f of tile.features) {
          const tags = f.tags as { layer: string; kind: string };
          if (z < DETAIL_MIN_ZOOM && isDetail(tags)) continue;
          (layers[tags.layer] ??= { features: [] }).features.push(f);
        }
      }
    }
    if (Object.keys(layers).length) out = Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: 4096 }));
  }
  world.tileCache.set(key, out);
  if (world.tileCache.size > MAX_TILES) world.tileCache.delete(world.tileCache.keys().next().value!);
  return out;
}

const DEM_SIZE = 256;
export const DEM_MIN_ZOOM = 9;
export const DEM_MAX_ZOOM = 13;
const CARVE_MAX_STEP = 80;  // valleys are narrower than cells coarser than this (m)
const building = new Map<string, Promise<Buffer>>();

/**
 * Elevation tile (Terrarium-encoded PNG) for hillshading and 3D terrain. Computed on a
 * worker thread from the relief function on first request, then kept in the world's database.
 */
export async function getDemTile(world: World, z: number, x: number, y: number): Promise<Buffer | null> {
  const b = world.meta.bounds;
  if (!b || z < DEM_MIN_ZOOM || z > DEM_MAX_ZOOM) return null;
  const size = (2 * HALF_WORLD) / 2 ** z;
  const minx = -HALF_WORLD + x * size, maxy = HALF_WORLD - y * size;
  if (minx > (b.x1 + 0.5) * CHUNK || minx + size < (b.x0 - 0.5) * CHUNK || maxy < (b.y0 - 0.5) * CHUNK || maxy - size > (b.y1 + 0.5) * CHUNK) return null;
  const saved = world.db.prepare('SELECT png FROM dem_tiles WHERE z = ? AND x = ? AND y = ?').get(z, x, y) as { png: Uint8Array } | undefined;
  if (saved) return Buffer.from(saved.png);
  const key = `${world.meta.id}/${z}/${x}/${y}`;
  let job = building.get(key);
  if (!job) {
    const step = size / DEM_SIZE;
    const [ox, oy] = world.meta.origin;
    job = run({
      type: 'dem', seed: world.seedNumber, origin: world.meta.origin, size: DEM_SIZE, step, carve: step <= CARVE_MAX_STEP,
      x0: ox + minx + step / 2, y0: oy + maxy - size + step / 2,
    }).then((r: { grid: Float32Array; ms: number }) => {
      // Row 0 of the grid is the southern edge; PNG rows run north to south.
      const rgb = new Uint8Array(DEM_SIZE * DEM_SIZE * 3);
      for (let row = 0; row < DEM_SIZE; row++) {
        for (let col = 0; col < DEM_SIZE; col++) {
          const v = r.grid[(DEM_SIZE - 1 - row) * DEM_SIZE + col] + 32768;
          const o = (row * DEM_SIZE + col) * 3;
          rgb[o] = Math.floor(v / 256);
          rgb[o + 1] = Math.floor(v) % 256;
          rgb[o + 2] = Math.floor((v - Math.floor(v)) * 256);
        }
      }
      const png = encodePng(DEM_SIZE, DEM_SIZE, rgb);
      world.db.prepare('INSERT OR REPLACE INTO dem_tiles (z, x, y, ms, png) VALUES (?, ?, ?, ?, ?)').run(z, x, y, r.ms, png);
      return png;
    }).finally(() => building.delete(key));
    building.set(key, job);
  }
  return job;
}

function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let r = 0; r < h; r++) raw.set(rgb.subarray(r * w * 3, (r + 1) * w * 3), r * (w * 3 + 1) + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;  // bit depth
  head[9] = 2;  // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
