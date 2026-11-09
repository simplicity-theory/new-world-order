import assert from 'node:assert/strict';
import { test } from 'node:test';
import { think } from './ai.ts';
import { NEUTRAL, PLAYER, RIVAL, RULES } from './rules.ts';
import { Sim, attackPower, defencePower, fight, newState, speedOn, type RawGraph } from './sim.ts';

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

test('the player starts in the middle town; the rest are neutral and garrisoned', () => {
  const { s, me } = game();
  assert.equal(me.capital, 'c');
  assert.equal(s.towns.c.owner, PLAYER);
  assert.deepEqual(s.towns.a.garrison, RULES.neutralGarrison[1]);
  assert.equal(s.towns.a.owner, NEUTRAL);
});

test('a town earns its income per minute', () => {
  const { sim, me } = game();
  const before = me.money;
  run(sim, 60);
  assert.ok(Math.abs(me.money - before - RULES.income[1]) < 0.5);
});

test('units cost upkeep, and money never goes below zero', () => {
  const { sim, s, me } = game();
  s.towns.c.garrison.infantry = 10;
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

test('repeat training keeps queueing while there is money', () => {
  const { sim, s } = game();
  s.towns.c.buildings.barracks = { done: true, progress: 0, queue: 0, training: 0, repeat: false };
  sim.command({ type: 'repeat', town: 'c', unit: 'infantry', on: true });
  run(sim, RULES.units.infantry.time * 3 + 2);
  assert.equal(s.towns.c.garrison.infantry, 3);
});

test('fights: the stronger side wins and loses more the closer it was', () => {
  const easy = fight({ infantry: 20, vehicle: 0 }, 20, { infantry: 2, vehicle: 0 }, 3);
  assert.equal(easy.win, true);
  assert.equal(easy.att.infantry, 19);
  const close = fight({ infantry: 10, vehicle: 0 }, 10, { infantry: 6, vehicle: 0 }, 9);
  assert.equal(close.win, true);
  assert.ok(close.att.infantry <= 2);
  const lost = fight({ infantry: 4, vehicle: 0 }, 4, { infantry: 5, vehicle: 0 }, 7.5);
  assert.equal(lost.win, false);
  assert.equal(lost.att.infantry, 0);
  assert.ok(lost.def.infantry >= 3);
  assert.equal(attackPower({ infantry: 2, vehicle: 2 }), 8);
  assert.equal(defencePower({ infantry: 2, vehicle: 2 }, 1.5), 12);
});

test('a strong enough group takes a town; a weak one is destroyed', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 12;
  assert.deepEqual(sim.command({ type: 'move', from: 'c', to: 'd', infantry: 10 }), { ok: true });
  assert.equal(s.groups.length, 1);
  run(sim, 4000 / speedOn({ infantry: 1, vehicle: 0 }, 'secondary') + 1);
  assert.equal(s.towns.d.owner, PLAYER);
  assert.ok(s.towns.d.garrison.infantry >= 4 && s.towns.d.garrison.infantry < 10);
  sim.command({ type: 'move', from: 'c', to: 'b', infantry: 2 });
  run(sim, 60);
  assert.equal(s.towns.b.owner, NEUTRAL);
  assert.equal(s.groups.length, 0);
  assert.ok(s.towns.b.garrison.infantry < RULES.neutralGarrison[1].infantry);
});

test('a group halts at the first hostile town on its route', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 30;
  sim.command({ type: 'move', from: 'c', to: 'e', infantry: 30 });
  run(sim, 60);
  assert.equal(s.towns.d.owner, PLAYER);
  assert.equal(s.towns.e.owner, NEUTRAL);
  assert.equal(s.groups.length, 0);
});

test('hill sites and fortifications make a town harder to take', () => {
  const { sim, s } = game();
  sim.nodes.get('d')!.traits.hill = true;
  s.towns.d.fort = 2;
  assert.equal(sim.defenceOf('d'), 1.75);
  s.towns.c.garrison.infantry = 7;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 7 }); // 7 against 3 × 1.5 × 1.75 = 7.9; it would beat the plain 4.5
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
  s.towns.d.owner = PLAYER;
  s.towns.e.owner = PLAYER;
  sim.upkeepSupplyVision();
  assert.equal(s.towns.e.supplied, true);
  const full = sim.incomeOf('e');
  sim.command({ type: 'cut', road: 'd|e' });
  sim.upkeepSupplyVision();
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

test('newly trained units march to the rally point', () => {
  const { sim, s } = game();
  s.towns.d.owner = PLAYER;
  s.towns.d.garrison = { infantry: 0, vehicle: 0 };
  s.towns.c.buildings.barracks = { done: true, progress: 0, queue: 0, training: 0, repeat: false };
  assert.deepEqual(sim.command({ type: 'rally', town: 'c', to: 'a' }), { error: 'a rally point must be another town you hold' });
  sim.command({ type: 'rally', town: 'c', to: 'd' });
  sim.command({ type: 'train', town: 'c', unit: 'infantry' });
  run(sim, RULES.units.infantry.time + 60);
  assert.equal(s.towns.c.garrison.infantry, 0);
  assert.equal(s.towns.d.garrison.infantry, 1);
});

test('a group on the road can be recalled', () => {
  const { sim, s } = game();
  s.towns.c.garrison.infantry = 30;
  sim.command({ type: 'move', from: 'c', to: 'd', infantry: 30 });
  run(sim, 5);
  assert.deepEqual(sim.command({ type: 'redirect', group: s.groups[0].id }), { ok: true });
  run(sim, 10);
  assert.equal(s.groups.length, 0);
  assert.equal(s.towns.c.garrison.infantry, 30);
  assert.equal(s.towns.d.owner, NEUTRAL);
});

test('hostile groups that meet on a road fight', () => {
  const { sim, s } = game(true);
  const rival = sim.faction(RIVAL);
  const home = rival.capital;
  s.towns.c.garrison.infantry = 20;
  s.towns[home].garrison.infantry = 5;
  // Clear the way so the two groups walk straight at each other.
  for (const id of ['a', 'b', 'd', 'e']) if (id !== home) { s.towns[id].owner = PLAYER; s.towns[id].garrison = { infantry: 0, vehicle: 0 }; }
  const near = home === 'a' ? 'b' : 'd';
  sim.command({ type: 'move', from: 'c', to: near, infantry: 20 });
  run(sim, 60);
  sim.command({ type: 'move', from: near, to: home, infantry: 20 });
  sim.command({ type: 'move', from: home, to: near, infantry: 5 }, RIVAL);
  run(sim, 30);
  assert.equal(s.groups.filter((g) => g.owner === RIVAL).length, 0);
  assert.equal(s.groups.filter((g) => g.owner === PLAYER).length, 1);
  assert.ok(s.groups[0].infantry < 20);
});

test('fog: unseen towns hide their owner, distant ones their defenders', () => {
  const { sim } = game(true);
  const v = sim.view(PLAYER) as any;
  assert.equal(v.towns.c.visible, true);
  assert.equal(v.towns.d.visible, true);       // 4 km away, inside the 7 km range
  assert.equal(v.towns.a.owner, -1);           // 8 km away and never seen
  assert.equal(v.towns.a.garrison, null);
  assert.equal(v.towns.c.buildings !== undefined, true);
  assert.equal(v.towns.d.buildings, undefined);
});

test('taking the rival capital wins; holding most of the map wins', () => {
  const a = game(true);
  const home = a.sim.faction(RIVAL).capital;
  const next = home === 'a' ? 'b' : 'd';
  a.s.towns[next].owner = PLAYER;
  a.s.towns[next].garrison = { infantry: 40, vehicle: 0 };
  a.sim.command({ type: 'move', from: next, to: home, infantry: 40 });
  run(a.sim, 60);
  assert.equal(a.s.winner, PLAYER);
  assert.equal(a.sim.faction(RIVAL).alive, false);

  const b = game();
  for (const id of ['b', 'd']) b.s.towns[id].owner = PLAYER;
  b.sim.step(0.2);
  assert.equal(b.s.winner, PLAYER); // 3 of 5 towns is 60%
});

test('the rival builds up and expands on its own', () => {
  const { sim, s } = game(true);
  sim.brain = think;
  const rival = sim.faction(RIVAL);
  run(sim, 1500);
  const held = s.graph.towns.filter((t) => s.towns[t.id].owner === RIVAL).length;
  assert.ok(s.towns[rival.capital].buildings.barracks?.done);
  assert.ok(held >= 2 || s.winner !== null, `rival holds ${held} towns`);
});
