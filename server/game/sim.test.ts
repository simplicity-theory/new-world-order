import assert from 'node:assert/strict';
import { test } from 'node:test';
import { think } from './ai.ts';
import { NEUTRAL, PLAYER, RULES } from './rules.ts';

const RIVAL = 2;
import { Sim, attackPower, defencePower, fight, newBuilding, newState, share, speedOn, type RawGraph } from './sim.ts';

// A small hand-made map: five towns in a line, A–B–C–D–E, 4 km apart, plus a back road A–C.
const town = (id: string, x: number, tier = 1) => ({
  id, name: id.toUpperCase(), tier, r: 300, x, y: 0, outline: [], sites: [],
  traits: { hill: false, river: false, port: false, rail: false },
});
const road = (a: string, b: string, x0: number, x1: number, kind = 'secondary', bridge = false, bend = 0) => ({
  id: `${a}|${b}`, a, b, kind, ref: '', pts: bend ? [[x0, 0], [(x0 + x1) / 2, bend], [x1, 0]] : [[x0, 0], [x1, 0]],
  bridges: bridge ? [{ d: 1500, x: (x0 + x1) / 2, y: 0 }] : [],
}) as RawGraph['roads'][number];
const graph = (): RawGraph => ({
  towns: [town('a', -8000), town('b', -4000), town('c', 0), town('d', 4000), town('e', 8000)],
  roads: [road('a', 'b', -8000, -4000), road('b', 'c', -4000, 0, 'secondary', true), road('c', 'd', 0, 4000), road('d', 'e', 4000, 8000), road('a', 'c', -8000, 0, 'tertiary', false, 4000)],
});
/** A game where the player holds C and there is no rival, unless asked for. */
function game(rival = false) {
  const sim = new Sim(newState(graph(), rival));
  return { sim, s: sim.state, me: sim.faction(PLAYER) };
}
const run = (sim: Sim, seconds: number) => { for (let t = 0; t < seconds * 5; t++) sim.step(0.2); };
const empty = () => ({ infantry: 0, scout: 0, vehicle: 0, artillery: 0 });
/** Hand a town to a side with a given garrison. */
const give = (sim: Sim, id: string, owner: number, infantry = 0) => { sim.state.towns[id].owner = owner; sim.state.towns[id].garrison = { ...empty(), infantry }; sim.refresh(); };
const armiesOf = (sim: Sim, owner: number) => sim.state.armies.filter((a) => a.owner === owner);

test('the player starts in the middle town; the rest are neutral and garrisoned', () => {
  const { s, me } = game();
  assert.equal(me.capital, 'c');
  assert.equal(s.towns.c.owner, PLAYER);
  assert.deepEqual(s.towns.a.garrison, { ...empty(), ...RULES.neutralGarrison[1] });
  assert.equal(s.towns.a.owner, NEUTRAL);
});

test('a town earns its income per minute', () => {
  const { sim, me } = game();
  const before = me.money;
  run(sim, 60);
  assert.ok(Math.abs(me.money - before - RULES.income[1]) < 0.5);
});

test('units cost upkeep, in a garrison or an army, and money never goes below zero', () => {
  const { sim, s, me } = game();
  s.towns.c.garrison.infantry = 10;
  sim.command({ type: 'muster', town: 'c', infantry: 4 });
  const before = me.money;
  run(sim, 60);
  assert.ok(Math.abs(me.money - before - (RULES.income[1] - 10 * RULES.units.infantry.upkeep)) < 0.5);
  s.towns.c.garrison.vehicle = 500;
  run(sim, 60);
  assert.equal(me.money, 0);
});

test('building and training take money and time', () => {
  const { sim, s, me } = game();
  assert.deepEqual(sim.command({ type: 'train', town: 'c', unit: 'infantry' }), { error: 'needs a finished infantry base' });
  assert.deepEqual(sim.command({ type: 'build', town: 'c', building: 'barracks' }), { ok: true });
  assert.equal(me.money, RULES.startMoney - RULES.buildings.barracks.cost);
  run(sim, RULES.buildings.barracks.time - 1);
  assert.equal(s.towns.c.buildings.barracks!.done, false);
  run(sim, 2);
  assert.equal(s.towns.c.buildings.barracks!.done, true);
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  run(sim, RULES.units.infantry.time + 1);
  assert.equal(s.towns.c.garrison.infantry, 1);
  assert.deepEqual(sim.command({ type: 'build', town: 'a', building: 'barracks' }), { error: 'not your town' });
});

test('cancelling takes a unit off the queue and refunds it', () => {
  const { sim, s, me } = game();
  s.towns.c.buildings.barracks = newBuilding('barracks', true);
  assert.deepEqual(sim.command({ type: 'cancel', town: 'c', unit: 'infantry' }), { error: 'nothing in training' });
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  const before = me.money;
  assert.deepEqual(sim.command({ type: 'cancel', town: 'c', unit: 'infantry' }), { ok: true });
  assert.equal(s.towns.c.buildings.barracks!.lines.infantry!.queue, 1);
  assert.equal(me.money, before + RULES.units.infantry.cost);
});

test('repeat training keeps queueing while there is money', () => {
  const { sim, s } = game();
  s.towns.c.buildings.barracks = newBuilding('barracks', true);
  sim.command({ type: 'repeat', town: 'c', unit: 'infantry', on: true });
  run(sim, RULES.units.infantry.time * 3 + 2);
  assert.equal(s.towns.c.garrison.infantry, 3);
});

test('fights: the stronger side wins, loses more the closer it was, and the loser keeps a share', () => {
  const easy = fight(20, 3);
  assert.equal(easy.win, true);
  assert.equal(share({ infantry: 20, vehicle: 0 }, 1 - easy.loss, true).infantry, 20);
  const close = fight(10, 9);
  assert.ok(close.win && close.loss > 0.5 && close.loss < 0.75);
  assert.ok(close.keep > easy.keep);
  assert.equal(fight(4, 7.5).win, false);
  assert.equal(fight(5, 5).win, false); // a tie goes to the defender
  assert.equal(attackPower({ infantry: 2, vehicle: 2 }), 8);
  assert.equal(defencePower({ infantry: 2, vehicle: 2 }, 1.5), 12);
});

test('an army that takes a town camps there as an army', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 12;
  assert.deepEqual(sim.command({ type: 'move', from: 'c', to: 'd', infantry: 10 }), { ok: true });
  assert.equal(s.armies.length, 1);
  assert.equal(s.armies[0].name, '1st Army');
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 1);
  assert.equal(s.towns.d.owner, PLAYER);
  assert.deepEqual(s.towns.d.garrison, empty());
  assert.equal(s.armies.length, 1);
  assert.equal(s.armies[0].at, 'd');
  assert.ok(s.armies[0].infantry >= 4 && s.armies[0].infantry < 10);
  assert.equal(sim.strengthOf('d'), defencePower(s.armies[0], 1) * 1.1); // it defends the town it is camped in, with a star for the win
});

test('a beaten attacker retreats home with part of its force', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 4;
  sim.command({ type: 'move', from: 'c', to: 'b', infantry: 4 }); // 4 against 3 × 1.5 = 4.5
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 1);
  assert.equal(s.towns.b.owner, NEUTRAL);
  assert.ok(s.towns.b.garrison.infantry < 3);
  assert.equal(s.armies.length, 1);
  assert.equal(s.armies[0].retreating, true);
  assert.equal(s.armies[0].infantry, 2);
  assert.deepEqual(sim.command({ type: 'redirect', army: s.armies[0].id, to: 'd' }), { error: 'that army is retreating and takes no orders' });
  run(sim, 60);
  assert.equal(s.armies[0].at, 'c');
  assert.equal(s.armies[0].retreating, false);
});

test('defenders who lose a town retreat to the next one their side holds', () => {
  const { sim, s } = game(true);
  const rival = sim.faction(RIVAL).capital, near = rival === 'a' ? 'b' : 'd';
  give(sim, near, RIVAL, 6);
  s.towns.c.garrison.infantry = 30;
  sim.command({ type: 'move', from: 'c', to: near, infantry: 30 });
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 1);
  assert.equal(s.towns[near].owner, PLAYER);
  const fled = armiesOf(sim, RIVAL);
  assert.equal(fled.length, 1);
  assert.equal(fled[0].retreating, true);
  assert.equal(fled[0].to, rival);
  assert.ok(fled[0].infantry >= 1 && fled[0].infantry <= 3);
});

test('an army halts at the first hostile town on its route', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 30;
  sim.command({ type: 'move', from: 'c', to: 'e', infantry: 30 });
  run(sim, 60);
  assert.equal(s.towns.d.owner, PLAYER);
  assert.equal(s.towns.e.owner, NEUTRAL);
  assert.equal(s.armies[0].at, 'd');
});

test('a fortified town must be besieged; the siege breaches its walls', () => {
  const { sim, s } = game();
  s.towns.d.fort = 2;
  assert.equal(sim.siegeNeed('d'), 2 * RULES.siege.perFort);
  assert.equal(sim.defenceOf('d'), 1.5);
  assert.equal(sim.defenceOf('d', true), 1);
  s.towns.c.garrison.infantry = 6;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 6 }); // 6 beats 4.5 breached, not 6.75 behind the walls
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 2);
  assert.equal(s.towns.d.owner, NEUTRAL);
  assert.ok(s.armies[0].siege);
  assert.equal(sim.incomeOf('d'), 0);
  run(sim, sim.siegeNeed('d'));
  assert.equal(s.towns.d.owner, PLAYER);
});

test('storming a besieged town at once means facing the walls', () => {
  const { sim, s } = game();
  s.towns.d.fort = 2;
  s.towns.c.garrison.infantry = 6;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 6 });
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 2);
  assert.deepEqual(sim.command({ type: 'storm', army: s.armies[0].id }), { ok: true });
  assert.equal(s.towns.d.owner, NEUTRAL);
  assert.equal(s.armies[0].retreating, true);
});

test('a relief force can break a siege, and its losers fall back', () => {
  const { sim, s } = game(true);
  const home = sim.faction(RIVAL).capital, near = home === 'a' ? 'b' : 'd';
  give(sim, near, RIVAL, 2);
  s.towns[near].fort = 3;
  s.towns.c.garrison.infantry = 8;
  sim.command({ type: 'move', from: 'c', to: near, infantry: 8 });
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 2);
  assert.ok(armiesOf(sim, PLAYER)[0].siege);
  s.towns[home].garrison.infantry = 20;
  sim.command({ type: 'move', from: home, to: near, infantry: 20 }, RIVAL);
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 2);
  assert.equal(s.towns[near].owner, RIVAL);
  assert.equal(sim.besiegersOf(near).length, 0);
  const mine = armiesOf(sim, PLAYER);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].retreating, true);
  assert.equal(armiesOf(sim, RIVAL)[0].at, near);
});

test('armies can be formed, split, merged and stood down', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 10;
  sim.command({ type: 'muster', town: 'c', infantry: 6 });
  const first = s.armies[0];
  assert.equal(first.at, 'c');
  assert.equal(s.towns.c.garrison.infantry, 4);
  assert.deepEqual(sim.command({ type: 'split', army: first.id, infantry: 6 }), { error: 'pick some of its units, not all or none' });
  sim.command({ type: 'split', army: first.id, infantry: 2 });
  assert.deepEqual(s.armies.map((a) => a.infantry), [4, 2]);
  sim.command({ type: 'rename', army: first.id, name: 'Old Guard' });
  sim.command({ type: 'merge', army: first.id });
  assert.equal(s.armies.length, 1);
  assert.equal(first.infantry, 6);
  assert.equal(first.name, 'Old Guard');
  sim.command({ type: 'garrison', army: first.id });
  assert.equal(s.armies.length, 0);
  assert.equal(s.towns.c.garrison.infantry, 10);
});

test('winning fights earns an army stars, which make it stronger', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 20;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 20 });
  run(sim, 60);
  const army = s.armies[0];
  assert.equal(army.stars, 1);
  assert.equal(sim.strengthOf('d'), army.infantry * RULES.units.infantry.defence * 1.1);
  sim.command({ type: 'redirect', army: army.id, to: 'e' });
  run(sim, 60);
  assert.equal(s.towns.e.owner, PLAYER);
  assert.equal(army.stars, 2);
  sim.command({ type: 'split', army: army.id, infantry: 2 });
  assert.equal(s.armies[1].stars, 2);
});

test('an army follows queued waypoints, taking towns as it goes', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 40;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 40 });
  const army = s.armies[0];
  assert.deepEqual(sim.command({ type: 'redirect', army: army.id, to: 'e', queue: true }), { ok: true });
  assert.deepEqual(army.orders, ['e']);
  run(sim, 120);
  assert.equal(s.towns.d.owner, PLAYER);
  assert.equal(s.towns.e.owner, PLAYER);
  assert.equal(army.at, 'e');
  assert.deepEqual(army.orders, []);
});

test('a neutral town recovers its losses over time', () => {
  const { sim, s } = game();
  s.towns.d.garrison.infantry = 1;
  run(sim, RULES.neutralRecover * 2 + 1);
  assert.equal(s.towns.d.garrison.infantry, 3);
  run(sim, RULES.neutralRecover * 2);
  assert.equal(s.towns.d.garrison.infantry, RULES.neutralGarrison[1].infantry);
});

test('artillery counts for more against towns and speeds a siege; scouts see further', () => {
  const { sim, s } = game();
  assert.equal(attackPower({ artillery: 2 }), 2);
  assert.equal(attackPower({ artillery: 2 }, true), 10);
  s.towns.d.fort = 2;
  s.towns.c.garrison = { ...empty(), infantry: 4, artillery: 2 };
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 4, artillery: 2 });
  const pace = speedOn({ artillery: 1 }, 'secondary');
  assert.ok(pace > speedOn({ infantry: 1 }, 'secondary'));
  run(sim, 4000 / speedOn({ infantry: 1 }, 'secondary') + 2);
  assert.ok(s.armies[0].siege);
  run(sim, sim.siegeNeed('d') / 1.5 + 1); // two guns: half as fast again
  assert.equal(s.towns.d.owner, PLAYER);

  const b = game();
  b.s.towns.c.garrison = { ...empty(), scout: 1 };
  b.sim.command({ type: 'muster', town: 'c', scout: 1 });
  assert.equal(b.sim.eyes(PLAYER).find((e) => e[2] === RULES.units.scout.sight)?.[2], 9000);
});

test('a base trains infantry and scouts side by side', () => {
  const { sim, s } = game();
  s.towns.c.buildings.barracks = newBuilding('barracks', true);
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  sim.command({ type: 'train', town: 'c', unit: 'scout' });
  assert.deepEqual(sim.command({ type: 'train', town: 'c', unit: 'artillery' }), { error: 'needs a finished vehicle factory' });
  run(sim, RULES.units.infantry.time + 1);
  assert.equal(s.towns.c.garrison.infantry, 1);
  assert.equal(s.towns.c.garrison.scout, 1);
});

test('armies go by rail between towns their side holds, and not otherwise', () => {
  const map = graph();
  map.roads.push({ ...road('a', 'e', -8000, 8000, 'rail'), id: 'a|e|r' });
  const sim = new Sim(newState(map, false)), s = sim.state;
  const infantry = { infantry: 5 };
  give(sim, 'a', PLAYER, 5);
  assert.deepEqual(sim.route('a', 'e', infantry, PLAYER)!.legs.map((l) => l.road), ['a|b', 'b|c', 'c|d', 'd|e']); // E is not ours: no train
  give(sim, 'e', PLAYER);
  const byRail = sim.route('a', 'e', infantry, PLAYER)!;
  assert.deepEqual(byRail.legs.map((l) => l.road), ['a|e|r']);
  assert.ok(byRail.time < 20);
  assert.equal(sim.route('a', 'e', infantry)!.legs.length, 4); // nobody in particular: roads only
  sim.command({ type: 'move', from: 'a', to: 'e', infantry: 5 });
  run(sim, 20);
  assert.equal(s.armies[0].at, 'e');
});

test('a camped army can be ordered to march', () => {
  const { sim, s } = game();
  give(sim, 'd', PLAYER);
  s.towns.c.garrison.infantry = 5;
  sim.command({ type: 'muster', town: 'c', infantry: 5 });
  assert.deepEqual(sim.command({ type: 'redirect', army: s.armies[0].id, to: 'd' }), { ok: true });
  assert.equal(s.armies[0].at, null);
  run(sim, 60);
  assert.equal(s.armies[0].at, 'd');
  assert.equal(s.towns.d.garrison.infantry, 0);
});

test('hill sites make a town harder to take', () => {
  const { sim, s } = game();
  sim.nodes.get('d')!.traits.hill = true;
  assert.equal(sim.defenceOf('d'), 1.25);
  s.towns.c.garrison.infantry = 5;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 5 }); // 5 against 3 × 1.5 × 1.25 = 5.6; it would beat the plain 4.5
  run(sim, 60);
  assert.equal(s.towns.d.owner, NEUTRAL);
});

test('vehicles are quicker on better roads and choose their route by time', () => {
  const { sim } = game();
  assert.ok(speedOn({ infantry: 0, vehicle: 1 }, 'motorway') > speedOn({ infantry: 0, vehicle: 1 }, 'tertiary') * 2);
  assert.equal(speedOn({ infantry: 1, vehicle: 1 }, 'motorway'), speedOn({ infantry: 1, vehicle: 0 }, 'tertiary'));
  const r = sim.route('a', 'c', { infantry: 0, vehicle: 1 })!;
  assert.deepEqual(r.legs.map((l) => l.road), ['a|b', 'b|c']); // 8 km of secondary beats a longer tertiary back road
});

test('cutting a road forces a detour and costs less at a bridge', () => {
  const { sim, s, me } = game();
  me.money = 1000;
  assert.deepEqual(sim.command({ type: 'cut', road: 'd|e' }), { error: 'you must hold a town at one end of the road' });
  assert.deepEqual(sim.command({ type: 'cut', road: 'b|c' }), { ok: true });
  assert.equal(me.money, 1000 - RULES.roads.cutBridge);
  assert.deepEqual(s.graph.roads.find((r) => r.id === 'b|c')!.cutAt, [-2000, 0]);
  assert.deepEqual(sim.route('c', 'b', { infantry: 1, vehicle: 0 })!.legs.map((l) => l.road), ['a|c', 'a|b']);
  sim.command({ type: 'cut', road: 'a|c' });
  assert.equal(sim.route('c', 'b', { infantry: 1, vehicle: 0 }), null);
  assert.deepEqual(sim.command({ type: 'repair', road: 'b|c' }), { ok: true });
  run(sim, RULES.roads.repairBridgeTime + 1);
  assert.equal(s.graph.roads.find((r) => r.id === 'b|c')!.intact, true);
});

test('a town cut off from the capital earns half', () => {
  const { sim, s } = game();
  give(sim, 'd', PLAYER);
  give(sim, 'e', PLAYER);
  assert.equal(s.towns.e.supplied, true);
  const full = sim.incomeOf('e');
  sim.command({ type: 'cut', road: 'd|e' });
  sim.refresh();
  assert.equal(s.towns.e.supplied, false);
  assert.equal(sim.incomeOf('e'), full * RULES.cutOffShare);
});

test('upgrades raise income and defence and get dearer each level', () => {
  const { sim, s, me } = game();
  me.money = 5000;
  const income = sim.incomeOf('c'), cost = sim.upgradeCost('c', 'market');
  sim.command({ type: 'upgrade', town: 'c', upgrade: 'market' });
  assert.equal(sim.incomeOf('c'), income * 1.25);
  assert.equal(sim.upgradeCost('c', 'market'), cost * 2);
  sim.command({ type: 'upgrade', town: 'c', upgrade: 'fort' });
  assert.equal(s.towns.c.fort, 1);
  for (let k = 0; k < 5; k++) sim.command({ type: 'upgrade', town: 'c', upgrade: 'fort' });
  assert.equal(s.towns.c.fort, RULES.maxLevel);
});

test('newly trained units march to the rally point and join its garrison', () => {
  const { sim, s } = game();
  give(sim, 'd', PLAYER);
  s.towns.c.buildings.barracks = newBuilding('barracks', true);
  assert.deepEqual(sim.command({ type: 'rally', town: 'c', to: 'a' }), { error: 'a rally point must be another town you hold' });
  sim.command({ type: 'rally', town: 'c', to: 'd' });
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  run(sim, RULES.units.infantry.time + 60);
  assert.equal(s.towns.c.garrison.infantry, 0);
  assert.equal(s.towns.d.garrison.infantry, 1);
  assert.equal(s.armies.length, 0);
});

test('an army on the road can be recalled', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 30;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 30 });
  run(sim, 5);
  assert.deepEqual(sim.command({ type: 'redirect', army: s.armies[0].id }), { ok: true });
  run(sim, 10);
  assert.equal(s.armies[0].at, 'c');
  assert.equal(s.armies[0].infantry, 30);
  assert.equal(s.towns.d.owner, NEUTRAL);
});

test('hostile armies that meet on a road fight, and the loser falls back', () => {
  const { sim, s } = game(true);
  const home = sim.faction(RIVAL).capital, near = home === 'a' ? 'b' : 'd';
  give(sim, near, PLAYER, 20);
  s.towns[home].garrison.infantry = 8;
  sim.command({ type: 'move', from: near, to: home, infantry: 20 });
  sim.command({ type: 'move', from: home, to: near, infantry: 8 }, RIVAL);
  run(sim, 30);
  const theirs = armiesOf(sim, RIVAL), mine = armiesOf(sim, PLAYER);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].infantry < 20);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].retreating, true);
  assert.equal(theirs[0].to, home);
  assert.ok(theirs[0].infantry < 8);
});

test('fog: unseen towns hide their owner, distant ones their defenders', () => {
  const { sim } = game(true);
  const v = sim.view(PLAYER) as any;
  assert.equal(v.towns.c.visible, true);
  assert.equal(v.towns.d.visible, true);       // 4 km away, inside the 7 km range
  assert.equal(v.towns.a.owner, -1);           // 8 km away and never seen
  assert.equal(v.towns.a.garrison, null);
  assert.equal(v.towns.a.strength, null);
  assert.equal(v.towns.d.strength, 4.5);
  assert.equal(v.towns.c.buildings !== undefined, true);
  assert.equal(v.towns.d.buildings, undefined);
});

test('taking the rival capital wins; holding most of the map wins', () => {
  const a = game(true);
  const home = a.sim.faction(RIVAL).capital;
  const next = home === 'a' ? 'b' : 'd';
  give(a.sim, next, PLAYER, 40);
  a.sim.command({ type: 'move', from: next, to: home, infantry: 40 });
  run(a.sim, 60);
  assert.equal(a.s.winner, PLAYER);
  assert.equal(a.sim.faction(RIVAL).alive, false);

  const b = game();
  for (const id of ['b', 'd']) b.s.towns[id].owner = PLAYER;
  b.sim.step(0.2);
  assert.equal(b.s.winner, PLAYER); // 3 of 5 towns is 60%
});

test('with several rivals, beating one does not end the game; its towns turn neutral', () => {
  // A longer line of towns, so that taking a capital does not also win by share of the map.
  const big = graph();
  big.towns.push(town('f', 12000), town('g', 16000), town('h', 20000));
  big.roads.push(road('e', 'f', 8000, 12000), road('f', 'g', 12000, 16000), road('g', 'h', 16000, 20000));
  const sim = new Sim(newState(big, { rivals: 2 }));
  const s = sim.state;
  assert.equal(s.factions.length, 4);
  const [first, second] = [s.factions[2], s.factions[3]];
  assert.notEqual(first.capital, second.capital);
  const next = sim.links.get(first.capital)![0].other;
  const extra = big.towns.map((t) => t.id).find((id) => id !== 'c' && id !== next && id !== first.capital && id !== second.capital)!;
  give(sim, extra, first.id, 1);
  // March on the first rival's capital from next door.
  give(sim, next, PLAYER, 40);
  sim.command({ type: 'move', from: next, to: first.capital, infantry: 40 });
  run(sim, 200);
  assert.equal(first.alive, false);
  assert.equal(s.winner, null);
  assert.equal(s.towns[extra].owner, NEUTRAL);
  assert.ok(s.tally[PLAYER].won >= 1);
  assert.ok(s.history.length >= 2);
});

test('the rival cuts the road in front of an army it cannot stop', () => {
  const { sim, s } = game(true);
  sim.brain = think;
  const home = sim.faction(RIVAL).capital, far = home === 'a' ? 'c' : 'c';
  sim.faction(RIVAL).money = 1000;
  s.towns.c.garrison.infantry = 60;
  sim.command({ type: 'move', from: 'c', to: home, infantry: 60 });
  assert.equal(s.armies[0].path.length, 2, far);
  run(sim, 10);
  const last = s.graph.roads.find((r) => r.id === s.armies[0].path[1]?.road || (r.a === home || r.b === home) && !r.intact);
  assert.ok(s.graph.roads.some((r) => (r.a === home || r.b === home) && !r.intact), `a road into the capital should be cut (${last?.id})`);
});

test('the rival builds up, expands, and keeps a guard at home', () => {
  const { sim, s } = game(true);
  sim.brain = think;
  const rival = sim.faction(RIVAL);
  s.towns.c.garrison.infantry = 40; // so the game is not over before it has done anything
  run(sim, 1500);
  const held = s.graph.towns.filter((t) => s.towns[t.id].owner === RIVAL).length;
  assert.ok(s.towns[rival.capital].buildings.barracks?.done);
  assert.ok(held >= 2, `rival holds ${held} towns`);
  assert.ok(s.towns[rival.capital].garrison.infantry >= 3, 'the capital keeps a guard');
});

test('the rival sends relief to a town of its own under siege', () => {
  const { sim, s } = game(true);
  sim.brain = think;
  const home = sim.faction(RIVAL).capital, near = home === 'a' ? 'b' : 'd';
  give(sim, near, RIVAL, 2);
  s.towns[near].fort = 3;
  s.towns[home].garrison.infantry = 30;
  s.towns.c.garrison.infantry = 8;
  sim.command({ type: 'move', from: 'c', to: near, infantry: 8 });
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 2);
  assert.equal(sim.besiegersOf(near).length, 1);
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 8);
  assert.equal(sim.besiegersOf(near).length, 0);
  assert.equal(s.towns[near].owner, RIVAL);
});
