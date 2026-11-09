import { fbm, hashInt, noise2 } from './rng.ts';

/**
 * Terrain is a pure function of (seed, x, y) in metres. Any point in the world has a
 * defined elevation before it is ever generated, which is what keeps chunks seamless.
 *
 * Layers, coarse to fine: macroBase (continents and mountain ranges) → base (adds hills,
 * offshore islands and the broad valleys of the major rivers) → elev (adds small bumps).
 * relief.ts then cuts the local river valleys for display and routing.
 */
export class Terrain {
  seed: number;
  private s: number[];
  /** Valley floor height imposed by the major rivers (see trunk.ts); huge where there is none. */
  valleys: ((x: number, y: number) => number) | null = null;

  constructor(seed: number) {
    this.seed = seed;
    this.s = Array.from({ length: 16 }, (_, i) => hashInt(seed, i + 1, 77));
  }

  private mountain(x: number, y: number): number {
    const m = fbm(this.s[3], x / 60000, y / 60000, 2);
    const t = Math.min(1, Math.max(0, (m - 0.12) / 0.4));
    return t * t * (3 - 2 * t);
  }

  /** Continental shape only. The major-river network drains this surface. */
  macroBase(x: number, y: number): number {
    const s = this.s;
    const wx = x + 1800 * fbm(s[0], x / 7000, y / 7000, 2);
    const wy = y + 1800 * fbm(s[1], x / 7000, y / 7000, 2);
    const m = this.mountain(x, y);
    return 38 + 270 * fbm(s[2], wx / 45000, wy / 45000, 3) + 180 * m * m;
  }

  /** Smooth large-scale elevation (m). Local drainage is computed on this. */
  base(x: number, y: number): number {
    const s = this.s;
    const wx = x + 1800 * fbm(s[0], x / 7000, y / 7000, 2);
    const wy = y + 1800 * fbm(s[1], x / 7000, y / 7000, 2);
    const m = this.mountain(x, y);
    let b = 38 + 270 * fbm(s[2], wx / 45000, wy / 45000, 3) + 180 * m * m
      + fbm(s[4], wx / 9000, wy / 9000, 2) * (45 + 240 * m);
    if (b < 0 && b > -60) {
      // Offshore islands on the shallow shelf.
      const isl = fbm(s[12], x / 2200, y / 2200, 2) - 0.36;
      if (isl > 0) b += isl * 170 * Math.max(0, 1 - Math.abs(b + 25) / 35);
    }
    if (this.valleys && b > 0.6) {
      const t = Math.max(0.6, this.valleys(x, y));
      const k = 12;
      if (t < b + k) {
        // Smooth minimum, so valley sides meet the hills without a crease.
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - t)) / k));
        b = Math.max(0.6, b + (t - b) * h - k * h * (1 - h));
      }
    }
    return b;
  }

  /** Small-scale relief added on top of base(); `b` is base(x, y). */
  detail(x: number, y: number, b: number): number {
    const m = this.mountain(x, y);
    const fade = Math.min(1, Math.max(0.22, Math.abs(b) / 25));
    return fbm(this.s[5], x / 1300, y / 1300, 4) * (7 + 32 * m) * fade;
  }

  /** Full elevation (m), sea level at 0, before local valleys are carved (see relief.ts). */
  elev(x: number, y: number): number {
    const b = this.base(x, y);
    return b + this.detail(x, y, b);
  }

  moisture(x: number, y: number): number {
    return fbm(this.s[6], x / 6500, y / 6500, 3) + 0.4 * fbm(this.s[7], x / 650, y / 650, 3);
  }

  /** Broad wet and dry regions, without the small-scale variation of moisture(). */
  wetness(x: number, y: number): number {
    return fbm(this.s[6], x / 6500, y / 6500, 3);
  }

  fertility(x: number, y: number): number {
    return fbm(this.s[8], x / 3200, y / 3200, 3);
  }

  population(x: number, y: number): number {
    return fbm(this.s[9], x / 35000, y / 35000, 2);
  }

  /** Depth (m) to which tidal flats extend below sea level here; 0 along most coasts. */
  tide(x: number, y: number): number {
    return 2.2 * Math.max(0, fbm(this.s[13], x / 3500, y / 3500, 2) - 0.05);
  }

  /** Generic low-frequency variation in [-1, 1], used to keep thresholds from being level lines. */
  vary(x: number, y: number): number {
    return fbm(this.s[14], x / 2400, y / 2400, 2);
  }

  /** Small continuous displacement used to make rivers meander; `scale` 1 suits local rivers. */
  wiggle(x: number, y: number, scale = 1): [number, number] {
    const a = 38 * scale, l = 230 * scale;
    return [a * noise2(this.s[10], x / l, y / l), a * noise2(this.s[11], x / l, y / l)];
  }
}
