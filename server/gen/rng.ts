// Deterministic hashing and noise. Everything in the generator derives from these,
// so the same seed always yields the same world.

export function hashInt(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

export function rand01(a: number, b: number, c: number): number {
  return hashInt(a, b, c) / 4294967296;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GX = new Float64Array(32);
const GY = new Float64Array(32);
for (let i = 0; i < 32; i++) {
  GX[i] = Math.cos((i / 32) * Math.PI * 2);
  GY[i] = Math.sin((i / 32) * Math.PI * 2);
}

/** 2D gradient noise, roughly in [-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const h00 = hashInt(seed, xi, yi) & 31;
  const h10 = hashInt(seed, xi + 1, yi) & 31;
  const h01 = hashInt(seed, xi, yi + 1) & 31;
  const h11 = hashInt(seed, xi + 1, yi + 1) & 31;
  const n00 = GX[h00] * fx + GY[h00] * fy;
  const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
  const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
  const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.5;
}

/** Fractal noise, roughly in [-1, 1]. */
export function fbm(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(seed + o * 1013, x, y);
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}
