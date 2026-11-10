// Every number that shapes how Conquer plays, in one place.
// Times are in simulation seconds: one real second at 1× speed.

export const RULES = {
  /** The world is real scale, so travel runs this many times faster than real life. */
  timeScale: 60,
  tickSeconds: 0.2,
  startMoney: 400,
  /** Money per simulation minute, by settlement tier: hamlet, village, town, city. */
  income: [20, 40, 90, 200],
  /** Extra income for a port or a railway town, and the share kept by a town cut off from its capital. */
  portBonus: 0.25, railBonus: 0.25, cutOffShare: 0.5,
  buildings: {
    barracks: { name: 'Infantry base', cost: 200, time: 30, trains: ['infantry', 'scout'] },
    factory: { name: 'Vehicle factory', cost: 500, time: 60, trains: ['vehicle', 'artillery'] },
  },
  units: {
    // attack and defence are strength per unit; upkeep is money per minute.
    // `assault` replaces attack when storming a town; `sight` replaces an army's usual range of view (m).
    infantry: { name: 'Infantry', cost: 50, time: 10, attack: 1, defence: 1.5, upkeep: 2 },
    scout: { name: 'Scouts', cost: 40, time: 6, attack: 0.2, defence: 0.2, upkeep: 1, sight: 9000 },
    vehicle: { name: 'Vehicle', cost: 150, time: 20, attack: 3, defence: 2.5, upkeep: 6 },
    artillery: { name: 'Artillery', cost: 200, time: 25, attack: 1, defence: 1, upkeep: 6, assault: 5 },
  },
  /** Speed in km/h by road class. Infantry walk at the same pace anywhere; vehicles want good roads. */
  speed: {
    // `rail` is a railway: everything goes by train at the same speed, but only between two towns the same side holds.
    infantry: { motorway: 5, primary: 5, secondary: 5, tertiary: 5, rail: 60 },
    scout: { motorway: 30, primary: 30, secondary: 26, tertiary: 22, rail: 60 },
    vehicle: { motorway: 70, primary: 50, secondary: 38, tertiary: 24, rail: 60 },
    artillery: { motorway: 28, primary: 22, secondary: 16, tertiary: 9, rail: 60 },
  },
  maxQueue: 20,
  /** A neutral town that has lost defenders gets one back this often (seconds), up to what it started with. */
  neutralRecover: 45,
  /** Defenders in a town nobody owns, by tier. */
  neutralGarrison: [{ infantry: 1, vehicle: 0 }, { infantry: 3, vehicle: 0 }, { infantry: 9, vehicle: 1 }, { infantry: 20, vehicle: 5 }],
  /** Each of these adds this much to a town's defence: a hill site, a river, each level of fortification. */
  defenceBonus: { hill: 0.25, river: 0.25, fort: 0.25 },
  /** The winner loses this share of its units: lossScale × (loser strength / winner strength) ^ lossPower. */
  lossPower: 2, lossScale: 0.75,
  /** An army earns a star for each fight it wins, up to this many; each star adds this much to its strength. */
  experience: { max: 3, perStar: 0.1 },
  /** The losing side keeps this share of its units and retreats: base, plus more the closer the fight was. */
  retreat: { base: 0.25, close: 0.25 },
  /**
   * Seconds an army must besiege a town before its assault: per level of fortification, plus
   * extra for a town or a city. After a full siege the fortifications no longer count.
   */
  siege: { perFort: 25, town: 20, city: 40 },
  /** Each artillery piece in a besieging army speeds the siege by this much, up to the cap. */
  siegeGuns: { each: 0.25, cap: 2 },
  /** A garrison joining a relief force's fight against besiegers adds this share of its attack. */
  sortie: 0.5,
  /** Town upgrades: up to maxLevel each; a level costs base × (level + 1) × (tier + 1). */
  upgrades: {
    market: { name: 'Market', effect: 'income', perLevel: 0.25, base: 120 },
    fort: { name: 'Fortifications', effect: 'defence', perLevel: 0.25, base: 100 },
  },
  maxLevel: 3,
  /** Cutting a road is cheap at a bridge and slow to undo; elsewhere it costs more to cut and less to mend. */
  roads: { cut: 150, cutBridge: 60, repair: 150, repairBridge: 350, repairTime: 30, repairBridgeTime: 60 },
  /** How far you can see (m) from a town you hold and from a group on the road. */
  vision: { town: 7000, group: 4000 },
  /** Holding this share of all towns on the map wins the game; so does taking the rival's capital. */
  winShare: 0.6,
  /** Capturing a town this close to the edge of the map (km) adds this much land beyond it (km). */
  growth: { edgeKm: 5, addKm: 4 },
  /** Starting map sizes, in chunks (2 km each) east–west and north–south. Medium is 528 km². */
  sizes: { small: [7, 8], medium: [11, 12], large: [15, 16] },
  /** How the computer-run sides are tuned: their income, and the margin of strength they want before attacking. */
  difficulty: { easy: { income: 0.7, margin: 1.6 }, normal: { income: 1, margin: 1.3 }, hard: { income: 1.4, margin: 1.15 } },
  /** Names and colours for up to three rivals. */
  rivals: [{ name: 'Crimson League', color: '#d1345b' }, { name: 'Violet Pact', color: '#8e44ad' }, { name: 'Amber Host', color: '#c2610c' }],
  /** How often (simulation seconds) the number of towns each side holds is recorded for the end-of-game chart. */
  historyEvery: 20,
} as const;

export type BuildingKind = keyof typeof RULES.buildings;
export type UnitKind = keyof typeof RULES.units;
export type UpgradeKind = keyof typeof RULES.upgrades;
export type RoadKind = keyof typeof RULES.speed.vehicle;
export type Difficulty = keyof typeof RULES.difficulty;
export type MapSize = keyof typeof RULES.sizes;
export interface Settings { rivals: number; difficulty: Difficulty; size: MapSize }
export const DEFAULTS: Settings = { rivals: 1, difficulty: 'normal', size: 'medium' };
export const NEUTRAL = 0;
export const PLAYER = 1;
export const RIVAL = 2;
