// Browser tests for Conquer: plays the game through the real page in headless Chrome.
//
//   npm run test:browser            (set CHROME=/path/to/chrome if it is not at the default)
//
// The suite starts its own server on a spare port with a throwaway data folder, so it
// never touches saved worlds or games. It relies on the test-only `debug` command, which
// the server accepts only when CONQUER_DEBUG is set, as it is here.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 5600 + Math.floor(Math.random() * 300);
const ORIGIN = `http://localhost:${PORT}`, API = `${ORIGIN}/api/conquer`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const server = spawn('node', ['server/main.ts'], {
  cwd: join(import.meta.dirname, '..', '..'), stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(join(tmpdir(), 'conquer-test-')), CONQUER_DEBUG: '1' },
});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
for (let tries = 0; tries < 50; tries++) { try { await fetch(API); break; } catch { await sleep(200); } }

/** A fresh game and a page showing it, with helpers bound to both. */
async function game(settings = {}) {
  const g = await post('', { name: 'Test', seed: 'echo', size: 'small', rivals: 1, ...settings });
  const id = g.world.id, errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Old Guard' : undefined));
  await page.goto(`${ORIGIN}/conquer?game=${id}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.map && window.map.getLayer("cq-area")', { timeout: 30000 });
  await sleep(600);
  const town = (tid) => g.graph.towns.find((t) => t.id === tid);
  const capital = town(g.live.me.capital);
  // Neighbours of the capital by ordinary road, nearest first.
  const neighbours = g.graph.roads.filter((r) => !['rail', 'sea', 'motorway'].includes(r.kind) && (r.a === capital.id || r.b === capital.id))
    .sort((a, b) => a.length - b.length).map((r) => town(r.a === capital.id ? r.b : r.a));
  const T = {
    g, id, page, errors, capital, neighbours, town,
    command: (c) => post(`/${id}/command`, c),
    debug: (c) => post(`/${id}/command`, { type: 'debug', ...c }),
    live: async () => (await (await fetch(`${API}/${id}/game`)).json()).live,
    key: async (k, mod) => { if (mod) await page.keyboard.down(mod); await page.keyboard.press(k); if (mod) await page.keyboard.up(mod); await sleep(250); },
    text: (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s*\n+\s*/g, ' | ')),
    badge: async (t) => (await page.evaluateHandle((name) => [...document.querySelectorAll('.badge')].find((b) => b.dataset.tip?.startsWith(`${name}:`)), t.name)).boundingBox(),
    armies: () => page.evaluate(() => window.map.getSource('cq-groups').serialize().data.features.map((f) => ({ ...f.properties, ...window.map.project(f.geometry.coordinates) }))),
    until: (fn, arg, timeout = 60000) => page.waitForFunction(fn, { timeout }, arg),
    done: async () => { await page.close(); assert.deepEqual(errors, [], 'no errors on the page'); },
  };
  await T.key('h');
  return T;
}

const tests = {
  async 'build, train from the sidebar, cancel with a refund'() {
    const T = await game();
    await T.debug({ money: 1000 });
    await T.key('q');
    await T.command({ type: 'speed', value: 8 });
    await T.page.waitForSelector('#prod .tile[data-do="train:infantry"]', { timeout: 30000 });
    const tile = await (await T.page.$('#prod .tile[data-do="train:infantry"]')).boundingBox();
    await T.page.keyboard.down('Shift'); await T.page.mouse.click(tile.x + 15, tile.y + 15); await T.page.keyboard.up('Shift');
    await sleep(500);
    const queued = Number(await T.text('#prod .tile .count'));
    assert.ok(queued >= 4, `shift-click queues several (${queued})`);
    const before = (await T.live()).me.money;
    await T.page.mouse.click(tile.x + 15, tile.y + 15, { button: 'right' });
    await sleep(500);
    assert.ok((await T.live()).me.money > before + 40, 'cancelling refunds the unit');
    await T.done();
  },

  async 'pick unit cards, drag to attack, see the forecast and the report'() {
    const T = await game();
    const target = T.neighbours[0];
    await T.debug({ town: T.capital.id, infantry: 12 });
    await T.debug({ town: target.id, infantry: 2, fort: 0 });
    await sleep(400);
    assert.equal((await T.page.$$('#cmd .unit')).length, 12);
    const cards = await T.page.$$('#cmd .unit');
    await cards[0].click();
    assert.match(await T.text('#cmd .pick'), /^1 of 12/);
    await T.page.click('#cmd [data-do="pick:all"]');
    const from = await T.badge(T.capital), to = await T.badge(target);
    await T.page.mouse.move(from.x + 8, from.y + 8); await T.page.mouse.down();
    await T.page.mouse.move(from.x + 30, from.y + 50, { steps: 4 }); await T.page.mouse.move(to.x + 8, to.y + 8, { steps: 8 });
    await sleep(500);
    assert.match(await T.text('.fc'), /Win/);
    await T.page.mouse.up();
    await T.command({ type: 'speed', value: 8 });
    await T.page.waitForSelector('.report', { timeout: 60000 });
    assert.match(await T.text('.report'), /won/);
    assert.match(await T.text('#events'), /captured/);
    assert.equal((await T.live()).towns[target.id].owner, 1);
    await T.done();
  },

  async 'muster, split, rename, merge and stand down an army'() {
    const T = await game();
    await T.debug({ town: T.capital.id, infantry: 10 });
    await sleep(300);
    await T.page.click('#cmd [data-do="pick:half"]');
    await T.key('y');
    await sleep(400);
    await T.page.click('#cmd .banner');
    await sleep(300);
    await (await T.page.$$('#cmd .unit'))[0].click();
    await T.key('x');
    await sleep(400);
    assert.deepEqual((await T.armies()).map((a) => a.label).sort(), ['1', '4']);
    await T.key('n');
    await sleep(400);
    assert.match(await T.text('#cmd'), /^Old Guard/);
    await T.key('g');
    await sleep(400);
    assert.deepEqual((await T.armies()).map((a) => a.label), ['5']);
    await T.key('v');
    await sleep(500);
    assert.equal((await T.live()).armies.length, 0);
    assert.equal((await T.live()).towns[T.capital.id].garrison.infantry, 10);
    await T.done();
  },

  async 'besiege a walled town, with the siege alert; waypoints carry the army on'() {
    const T = await game();
    const [first, second] = T.neighbours;
    await T.debug({ town: T.capital.id, infantry: 40, artillery: 2 });
    await T.debug({ town: first.id, fort: 2 });
    await T.command({ type: 'move', from: T.capital.id, to: first.id, infantry: 40, artillery: 2 });
    const army = (await T.live()).armies[0];
    if (second) await T.command({ type: 'redirect', army: army.id, to: second.id, queue: true });
    await T.command({ type: 'speed', value: 8 });
    await T.page.waitForSelector('.alert[data-alert="siege"]', { timeout: 60000 });
    await T.until((id) => /captured/.test(document.querySelector('#events').innerText), null, 90000);
    const live = await T.live();
    assert.equal(live.towns[first.id].owner, 1);
    assert.ok(live.armies[0].stars >= 1, 'the army earned a star');
    await T.done();
  },

  async 'overview tables, road overlay, 3D, whole-map key and the minimap'() {
    const T = await game();
    await T.debug({ town: T.capital.id, infantry: 6 });
    await T.command({ type: 'muster', town: T.capital.id, infantry: 3 });
    await T.key('o');
    assert.match(await T.text('#sheet-body'), /Total a minute/);
    await T.page.click('#sheet [data-tab="armies"]');
    assert.match(await T.text('#sheet-body'), /1st Army/);
    await T.page.click('#sheet [data-tab="rivals"]');
    assert.match(await T.text('#sheet-body'), /Crimson League/);
    await T.key('Escape');
    await T.key('l');
    assert.equal(await T.page.evaluate(() => window.map.getLayoutProperty('cq-road-all', 'visibility')), 'visible');
    await T.key('l');
    const lng = await T.page.evaluate(() => window.map.getCenter().lng);
    const mini = await (await T.page.$('#mini')).boundingBox();
    await T.page.mouse.click(mini.x + 20, mini.y + 20);
    await sleep(300);
    assert.notEqual(await T.page.evaluate(() => window.map.getCenter().lng), lng, 'clicking the minimap moves the view');
    await T.page.click('#toggle-3d');
    await sleep(1500);
    assert.ok(await T.page.evaluate(() => !!window.map.getTerrain()));
    await T.done();
  },

  async 'a rival attack raises the alarm, pauses the game, and can be relieved'() {
    const T = await game();
    const [mine, theirs] = T.neighbours;
    assert.ok(mine && theirs, 'the capital needs two neighbours for this test');
    // The rival's staging town must itself be next to mine; pick one that is.
    const link = T.g.graph.roads.find((r) => !['rail', 'sea'].includes(r.kind) && (r.a === mine.id || r.b === mine.id) && ![T.capital.id].includes(r.a === mine.id ? r.b : r.a));
    const stage = link ? T.town(link.a === mine.id ? link.b : link.a) : theirs;
    await T.debug({ town: mine.id, owner: 1, infantry: 3, fort: 2 });
    await T.debug({ town: stage.id, owner: 2, infantry: 12 });
    await T.debug({ town: T.capital.id, infantry: 40 });
    assert.deepEqual(await T.debug({ as: 2, command: { type: 'move', from: stage.id, to: mine.id, infantry: 12 } }), { ok: true });
    await T.command({ type: 'speed', value: 4 });
    await T.page.waitForSelector('.alert[data-alert="attack"]', { timeout: 30000 });
    await T.until(() => /Paused/.test(document.querySelector('#toast').innerText), null, 90000);
    assert.equal((await T.live()).speed, 0);
    await T.command({ type: 'move', from: T.capital.id, to: mine.id, infantry: 40 });
    await T.command({ type: 'speed', value: 8 });
    await T.until(() => /broke the siege/.test(document.querySelector('#events').innerText), null, 90000);
    await T.done();
  },

  async 'buy a neutral neighbour; new-game dialog; winning shows the summary'() {
    const T = await game();
    const target = T.neighbours[0];
    await T.debug({ money: 5000 });
    const b = await T.badge(target);
    await T.page.mouse.click(b.x + 8, b.y + 8);
    await sleep(300);
    await T.key('u');
    await sleep(500);
    assert.equal((await T.live()).towns[target.id].owner, 1);
    await T.page.click('#new');
    await sleep(200);
    await T.page.select('#setup [name=rivals]', '2');
    await T.page.select('#setup [name=size]', 'small');
    await T.page.click('#setup button.primary');
    await T.until(() => document.querySelector('#veil').style.display === 'none' && new URLSearchParams(location.search).get('game') && document.querySelector('#events').innerText.includes('You hold'), null, 90000);
    await sleep(1000);
    const id = new URL(T.page.url()).searchParams.get('game');
    assert.notEqual(id, T.id);
    const full = await (await fetch(`${API}/${id}/game`)).json();
    assert.equal(full.live.factions.length, 4);
    for (const t of full.graph.towns.slice(0, Math.ceil(full.graph.towns.length * 0.7))) await post(`/${id}/command`, { type: 'debug', town: t.id, owner: 1 });
    await T.until(() => document.querySelector('#result').style.display === 'flex', null, 20000);
    assert.equal(await T.text('#result-title'), 'Victory');
    await T.done();
  },
};

let failed = 0;
const only = process.argv[2];
for (const [name, run] of Object.entries(tests)) {
  if (only && !name.includes(only)) continue;
  const t0 = Date.now();
  try { await run(); console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (err) { failed++; console.log(`✖ ${name}\n  ${String(err?.message ?? err).split('\n').slice(0, 6).join('\n  ')}`); }
}
await browser.close();
server.kill('SIGTERM');
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
