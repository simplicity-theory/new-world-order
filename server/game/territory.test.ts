import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointInRing } from '../gen/geom.ts';
import { sight, territory } from './territory.ts';

const town = (id: string, x: number) => ({ id, name: id, tier: 1, r: 300, x, y: 5000, outline: [], sites: [], traits: { hill: false, river: false, port: false, rail: false } });
const graph = {
  towns: [town('a', 2000), town('b', 6000), town('c', 12000)],
  roads: [{ id: 'a|b', a: 'a', b: 'b', kind: 'secondary', ref: '', pts: [[2000, 5000], [6000, 5000]] as [number, number][], length: 4000, bridges: [], intact: true, cutAt: null, repair: -1 }],
};
const bounds = { minx: 0, miny: 0, maxx: 14000, maxy: 10000 };
const covers = (rings: [number, number][][][], x: number, y: number) => rings.some((poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h)));

test('each side controls the land around its towns, and the road between two it holds', () => {
  const land = territory(graph, { a: 1, b: 1, c: 2 }, bounds);
  const mine = land.filter((p) => p.owner === 1).map((p) => p.rings), theirs = land.filter((p) => p.owner === 2).map((p) => p.rings);
  assert.ok(covers(mine, 2000, 5000) && covers(mine, 6000, 5000));
  assert.ok(covers(mine, 4000, 5200), 'the road between two held towns is covered');
  assert.ok(covers(theirs, 12000, 5000));
  assert.ok(!covers(mine, 12000, 5000) && !covers(theirs, 2000, 5000));
  assert.ok(!covers(mine, 9500, 9500) && !covers(theirs, 500, 500), 'far corners belong to nobody');
});

test('where two sides meet, the nearer town wins the ground', () => {
  const land = territory(graph, { a: 1, b: 2, c: 0 }, bounds);
  const mine = land.filter((p) => p.owner === 1).map((p) => p.rings), theirs = land.filter((p) => p.owner === 2).map((p) => p.rings);
  assert.ok(covers(mine, 3000, 5000) && !covers(theirs, 3000, 5000));
  assert.ok(covers(theirs, 5000, 5000) && !covers(mine, 5000, 5000));
  assert.equal(land.filter((p) => p.owner === 0).length, 0, 'neutral towns claim nothing');
});

test('sight is the area within range of an eye, kept off the map edge', () => {
  const seen = sight([[5000, 5000, 3000]], bounds);
  assert.equal(seen.length, 1);
  assert.ok(pointInRing(5000, 5000, seen[0]) && pointInRing(7500, 5000, seen[0]));
  assert.ok(!pointInRing(9000, 5000, seen[0]));
  const edge = sight([[100, 100, 3000]], bounds);
  assert.ok(edge[0].every(([x, y]) => x > 0 && y > 0), 'no point on the border');
});
