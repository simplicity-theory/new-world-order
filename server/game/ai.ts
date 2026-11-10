import { RULES } from './rules.ts';
import { attackPower, type Faction, type Sim, type Units } from './sim.ts';

// The rival. It plays by the same rules and through the same commands as the player.
// It builds and trains what it can afford, keeps a guard on towns that border someone
// else, marches to the relief of any town of its own under siege, and attacks the weakest
// neighbouring town when it can do so with a margin. It does not cut roads, and it knows
// what defends each town without having to see it.

const count = (u: Units): number => u.infantry + u.vehicle;

export function think(sim: Sim, f: Faction): void {
  const s = sim.state;
  const mine = s.graph.towns.filter((t) => s.towns[t.id].owner === f.id);
  if (!mine.length) return;
  const act = (c: Record<string, unknown>) => 'ok' in sim.command(c, f.id);
  const MARGIN = RULES.difficulty[s.settings?.difficulty ?? 'normal'].margin;

  // Armies that have come to rest in its own towns stand down, so every town's garrison is its whole force.
  for (const a of [...s.armies]) {
    if (a.owner === f.id && a.at && !a.siege && !a.retreating && s.towns[a.at].owner === f.id) act({ type: 'garrison', army: a.id });
  }

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

  const frontier = (id: string) => (sim.links.get(id) ?? []).filter((l) => l.road.intact && s.towns[l.other].owner !== f.id);
  /** What a town can spare: everything but a guard, which border towns and the capital always keep. */
  const spare = (id: string): Units => {
    const g = s.towns[id].garrison;
    const guard = id === f.capital ? 3 : frontier(id).length ? 2 : 0;
    const keepInf = Math.min(g.infantry, guard), keepVeh = Math.min(g.vehicle, guard - keepInf);
    return { infantry: g.infantry - keepInf, vehicle: g.vehicle - keepVeh };
  };

  // Relief: a town under siege gets everything the nearest towns can spare, if together that should break it.
  const busy = new Set<string>();
  for (const t of mine) {
    const besiegers = sim.besiegersOf(t.id);
    if (!besiegers.length) continue;
    const enemy = besiegers.reduce((n, b) => n + attackPower(b), 0);
    const dist = sim.distances(t.id);
    const helpers = mine.filter((o) => o.id !== t.id && dist.has(o.id) && count(spare(o.id)) && !sim.besiegersOf(o.id).length)
      .sort((a, b) => dist.get(a.id)! - dist.get(b.id)!).slice(0, 3);
    // Groups arrive one at a time, so the first to get there has to be able to win on its own, with the garrison's sortie.
    const sortie = RULES.sortie * attackPower(s.towns[t.id].garrison);
    for (const h of helpers) {
      if (attackPower(spare(h.id)) + sortie > enemy * 1.1) { act({ type: 'move', from: h.id, to: t.id, ...spare(h.id) }); busy.add(h.id); break; }
    }
  }

  // Roads: when an army too strong to stop is still more than one road away from a town of its own, it cuts
  // the last road in, preferring a bridge. Roads it has cut are mended once the danger has passed.
  const hunted = new Set<string>();
  for (const a of s.armies) {
    if (a.owner === f.id || a.at || a.retreating || s.towns[a.to]?.owner !== f.id || a.leg >= a.path.length - 1) continue;
    hunted.add(a.to);
    if (attackPower(a) <= sim.strengthOf(a.to, sim.siegeNeed(a.to) > 0)) continue;
    const last = sim.roads.get(a.path[a.path.length - 1].road)!;
    if (last.intact && f.money >= (last.bridges.length ? RULES.roads.cutBridge : RULES.roads.cut) + 50) act({ type: 'cut', road: last.id });
  }
  for (const r of s.graph.roads) {
    if (r.intact || r.repair >= 0 || hunted.has(r.a) || hunted.has(r.b)) continue;
    if ((s.towns[r.a].owner === f.id || s.towns[r.b].owner === f.id) && f.money >= (r.bridges.length ? RULES.roads.repairBridge : RULES.roads.repair) + 300) act({ type: 'repair', road: r.id });
  }

  // War: each garrison looks at the towns one road away.
  for (const t of mine) {
    if (busy.has(t.id) || sim.besiegersOf(t.id).length) continue;
    const force = spare(t.id);
    if (!count(force)) continue;
    // An army stops at the first town on its route that it does not hold, so that is the town it must be able to beat.
    const firstStop = (to: string): string => {
      const leg = sim.route(t.id, to, force)?.legs[0];
      if (!leg) return to;
      const road = sim.roads.get(leg.road)!;
      return leg.rev ? road.a : road.b;
    };
    const stops = [...new Set(frontier(t.id).map((l) => firstStop(l.other)))].filter((id) => s.towns[id].owner !== f.id);
    // A walled town will be besieged first, so what matters is its strength once the walls are breached.
    const targets = stops.map((id) => ({ id, need: sim.strengthOf(id, sim.siegeNeed(id) > 0) })).sort((a, b) => a.need - b.need);
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
