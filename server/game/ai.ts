import { RULES } from './rules.ts';
import { UNIT_KINDS, attackPower, defencePower, type Faction, type Sim, type Units } from './sim.ts';

// The rival. It plays by the same rules and through the same commands as the player.
// It builds and trains what it can afford, keeps a guard on towns that border someone
// else, marches to the relief of any town of its own under siege, and attacks the weakest
// neighbouring town when it can do so with a margin. It sees only what its own towns and
// armies can see, and guesses at the rest.

const count = (u: Partial<Units>): number => Object.values(u).reduce((n, v) => n + (v || 0), 0);

export function think(sim: Sim, f: Faction): void {
  const s = sim.state;
  const mine = s.graph.towns.filter((t) => s.towns[t.id].owner === f.id);
  if (!mine.length) return;
  const act = (c: Record<string, unknown>) => 'ok' in sim.command(c, f.id);
  const temper = RULES.tempers[f.temper ?? 'steady'];
  const MARGIN = RULES.difficulty[s.settings?.difficulty ?? 'normal'].margin * temper.margin;
  // It only knows what defends a town it can see; for the rest it assumes the usual garrison for a place that size, and a bit more.
  const inSight = sim.visible(f.id);
  // What it has seen or met in battle it remembers, and it never assumes a place is weaker than it last found it.
  const intel = (f.intel ??= {});
  for (const id of inSight) intel[id] = sim.strengthOf(id, true);
  const reckon = (id: string, breached: boolean): number => {
    if (inSight.has(id)) return sim.strengthOf(id, breached);
    const guess = defencePower(RULES.neutralGarrison[sim.nodes.get(id)!.tier], sim.defenceOf(id, breached)) * 1.3;
    return Math.max(guess, (intel[id] ?? 0) * 1.15);
  };

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
    if (st.buildings.factory?.done && st.buildings.factory.lines.vehicle!.queue < 1 && f.money >= RULES.units.vehicle.cost + 60) act({ type: 'train', town: t.id, unit: 'vehicle' });
    // A couple of guns, once there is a walled town within reach to use them on.
    if (st.buildings.factory?.done && st.buildings.factory.lines.artillery!.queue < 1 && (st.garrison.artillery || 0) < 2 && f.money >= RULES.units.artillery.cost + 100
      && (sim.links.get(t.id) ?? []).some((l) => s.towns[l.other].owner !== f.id && sim.siegeNeed(l.other) > 0)) act({ type: 'train', town: t.id, unit: 'artillery' });
    if (st.buildings.barracks?.done && st.buildings.barracks.lines.infantry!.queue < 2 && f.money >= RULES.units.infantry.cost + 30) act({ type: 'train', town: t.id, unit: 'infantry' });
  }

  // Spare money goes into markets, capital first: a bigger income is what breaks a stalemate.
  for (const t of [...mine].sort((p, q) => Number(q.id === f.capital) - Number(p.id === f.capital) || q.tier - p.tier)) {
    if (s.towns[t.id].market < RULES.maxLevel && f.money >= sim.upgradeCost(t.id, 'market') + 150) { act({ type: 'upgrade', town: t.id, upgrade: 'market' }); break; }
  }

  // A neutral town next door is bought when that is affordable with plenty to spare: cheaper than the men it would cost.
  for (const t of mine) {
    for (const l of sim.links.get(t.id) ?? []) {
      if (l.road.intact && s.towns[l.other].owner === 0 && inSight.has(l.other) && !sim.besiegersOf(l.other).length && f.money >= sim.bribeCost(l.other) * 1.4 + 100) act({ type: 'bribe', town: l.other });
    }
  }

  const frontier = (id: string) => (sim.links.get(id) ?? []).filter((l) => l.road.intact && l.road.kind !== 'rail' && l.road.kind !== 'sea' && s.towns[l.other].owner !== f.id && !sim.atPeace(f.id, s.towns[l.other].owner));
  /** What a town can spare: everything but a guard, which border towns and the capital always keep. */
  const spare = (id: string): Units => {
    const g = s.towns[id].garrison;
    const guard = Math.round((id === f.capital ? 3 : frontier(id).length ? 2 : 0) * temper.guard);
    // The guard is found from infantry first, then whatever else is there.
    let left = guard;
    const out = { ...g };
    for (const k of UNIT_KINDS) { const kept = Math.min(out[k] || 0, left); out[k] = (out[k] || 0) - kept; left -= kept; }
    return out;
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
    if (a.owner === f.id || a.at || a.retreating || s.towns[a.to]?.owner !== f.id || a.leg >= a.path.length - 1 || !sim.canSee(f.id, sim.position(a))) continue;
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
      const leg = sim.route(t.id, to, force, f.id)?.legs[0];
      if (!leg) return to;
      const road = sim.roads.get(leg.road)!;
      return leg.rev ? road.a : road.b;
    };
    const stops = [...new Set(frontier(t.id).map((l) => firstStop(l.other)))].filter((id) => s.towns[id].owner !== f.id && !sim.atPeace(f.id, s.towns[id].owner));
    // A walled town will be besieged first, so what matters is its strength once the walls are breached.
    const targets = stops.map((id) => ({ id, need: reckon(id, sim.siegeNeed(id) > 0) })).sort((a, b) => a.need - b.need);
    if (targets.length) {
      if (attackPower(force, true) > targets[0].need * MARGIN + 0.5) act({ type: 'move', from: t.id, to: targets[0].id, ...force });
      continue;
    }
    // Nothing to attack from here: move up to the nearest held town that has something in reach.
    const dist = sim.distances(t.id);
    const front = mine.filter((o) => o.id !== t.id && dist.has(o.id) && frontier(o.id).length)
      .sort((a, b) => dist.get(a.id)! - dist.get(b.id)!)[0];
    if (front) act({ type: 'move', from: t.id, to: front.id, ...force });
  }
}
