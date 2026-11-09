// Every number that shapes how Conquer plays, in one place.
// Times are in simulation seconds: one real second at 1× speed.

export const RULES = {
  /** The world is real scale, so travel runs this many times faster than real life. */
  timeScale: 60,
  tickSeconds: 0.2,
  startMoney: 400,
  /** Money per simulation minute, by settlement tier: hamlet, village, town, city. */
  income: [20, 40, 90, 200],
  buildings: {
    barracks: { name: 'Infantry base', cost: 200, time: 30, trains: 'infantry' },
    factory: { name: 'Vehicle factory', cost: 500, time: 60, trains: 'vehicle' },
  },
  units: {
    infantry: { name: 'Infantry', cost: 50, time: 10, kmh: 5 },
    vehicle: { name: 'Vehicle', cost: 150, time: 20, kmh: 40 },
  },
  maxQueue: 20,
  /** Capturing a town this close to the edge of the map (km) adds this much land beyond it (km). */
  growth: { edgeKm: 5, addKm: 4 },
  /** New games start on a map of this many chunks (2 km each) east–west and north–south: 528 km². */
  startChunks: [11, 12],
} as const;

export type BuildingKind = keyof typeof RULES.buildings;
export type UnitKind = keyof typeof RULES.units;
export const NEUTRAL = 0;
export const PLAYER = 1;
