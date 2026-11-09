import { RULES } from './rules.ts';
import { attackPower, defencePower, type Faction, type Sim, type Units } from './sim.ts';

// The rival. It plays by the same rules and through the same commands as the player:
// build a base, train what it can afford, and whenever a force is comfortably stronger
// than the weakest neighbouring town it does not hold, take it. It is deliberately
// simple: it does not cut roads, set rally points or defend.

const MARGIN = 1.3;

export function think(sim: Sim, f: Faction): void {
  const s = sim.state;
  const mine = s.graph.towns.filter((t) => s.towns[t.id].owner === f.id);
  if (!mine.length) return;
  const act = (c: Record<string, unknown>) => 'ok' in sim.command(c, f.id);

  // Economy: a base in the capital first, then in any larger town; a factory once there is money to spare.
  for (const t of mine) {
    const st = s.towns[t.id];
    const home = t.id === f.capital;
    if (!st.buildings.barracks && (home || t.tier >= 2) && f.money >= RULES.buildings.barracks.cost) act({ type: 'build', town: t.id, building: 'barracks' });
    if (!st.buildings.factory && st.buildings.barracks?.done && (home || t.tier >= 2) && f.money >= RULES.buildings.factory.cost + 200) act({ type: 'build', town: t.id, building: 'factory' });
    // Keep a little in hand so upkeep does not stall everything.
    if (st.buildings.factory?.done && st.buildings.factory.queue < 1 && f.money >= RULES.units.vehicle.cost + 60) act({ type: 'train', town: t.id, unit: 'vehicle' });
    if (st.buildings.barracks?.done && st.buildings.barracks.queue < 2 && f.money >= RULES.units.infantry.cost + 30) act({ type: 'train', town: t.id, unit: 'infantry' });
  }

  // War: each garrison looks at the towns one road away.
  const frontier = (id: string) => (sim.links.get(id) ?? []).filter((l) => l.road.intact && s.towns[l.other].owner !== f.id);
  for (const t of mine) {
    const st = s.towns[t.id];
    const force: Units = { ...st.garrison };
    if (!force.infantry && !force.vehicle) continue;
    // A group stops at the first town on its route that it does not hold, so that is the town it must be able to beat.
    const firstStop = (to: string): string => {
      const leg = sim.route(t.id, to, force)?.legs[0];
      if (!leg) return to;
      const road = sim.roads.get(leg.road)!;
      return leg.rev ? road.a : road.b;
    };
    const stops = [...new Set(frontier(t.id).map((l) => firstStop(l.other)))].filter((id) => s.towns[id].owner !== f.id);
    const targets = stops.map((id) => ({ id, need: defencePower(s.towns[id].garrison, sim.defenceOf(id)) })).sort((a, b) => a.need - b.need);
    if (targets.length) {
      if (attackPower(force) > targets[0].need * MARGIN + 0.5) act({ type: 'move', from: t.id, to: targets[0].id, ...force });
      continue;
    }
    // Nothing to attack from here: move up to the nearest held town that has something in reach.
    const dist = sim.distances(t.id);
    const front = mine.filter((o) => o.id !== t.id && dist.has(o.id) && frontier(o.id).length)
      .sort((a, b) => dist.get(a.id)! - dist.get(b.id)!)[0];
    if (front) act({ type: 'move', from: t.id, to: front.id, ...force });
  }
}
