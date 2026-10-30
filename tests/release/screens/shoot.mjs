// Photographs every page of pages.mjs at every width (and theme) with Playwright's Chromium (or the Chrome on this computer), into <out>/<theme>/<page>__<width>.png.
//   node shoot.mjs --out DIR --seeded URL --seeded-link LINK --seed seed.json [--fresh URL --fresh-link LINK] [--themes dark,light] [--only id,id] [--widths 1440,900,390]
// A page that cannot be photographed is recorded in results.json (with the reason) and the run goes on: one broken page never costs the others. The clock is fixed, animations and the caret are off,
// and a shot waits for the app's own ready signal and then for its requests to go quiet, so two runs of the same build look the same.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { PAGES, WIDTHS, DEFAULT_THEMES, THEMES } from './pages.mjs';
import { OPENERS } from './openers.mjs';
import { STUBS } from './stubs.mjs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('out'), seededBase = arg('seeded'), seededLink = arg('seeded-link'), freshBase = arg('fresh'), freshLink = arg('fresh-link'), seedFile = arg('seed');
const themes = (arg('themes') || DEFAULT_THEMES.join(',')).split(',').filter(t => THEMES.includes(t));
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const widthNames = arg('widths') ? new Set(arg('widths').split(',')) : null;
if (!out || !seededBase || !seededLink || !seedFile) { console.error('usage: shoot.mjs --out --seeded URL --seeded-link LINK --seed FILE [--fresh URL --fresh-link LINK] [--themes] [--only] [--widths]'); process.exit(2); }
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const FIXED_TIME = new Date('2026-10-30T12:00:00Z');
const log = (...a) => console.error('[shoot]', ...a);

const fill = p => p.replace(/\{(\w+)\}/g, (_, k) => ({
    team: seed.teams[0].name, agentWorking: seed.agents['Frontend Dev'].session_id, agentWaiting: seed.agents['Backend Dev'].session_id, agentIdle: seed.agents.Orchestrator.session_id,
    agentAsleep: seed.agents.Editor.session_id, goal: seed.goal, task: seed.tasks.cart, workflow: seed.workflow, run: seed.run, job: seed.job, chat: seed.chat,
}[k] ?? (() => { throw new Error('seed has no ' + k); })()));

const browser = await chromium.launch({ ...(process.env.SCREENS_CHROME ? { executablePath: process.env.SCREENS_CHROME } : { channel: process.env.SCREENS_CHANNEL || 'chrome' }), headless: true });

async function signedIn(base, link) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.__coralReady);
    const state = await ctx.storageState();
    await ctx.close();
    return state;
}

/** Waits until the page's requests have been quiet for a moment (its own polls and sockets never end, so "network idle" is not a signal). */
async function settle(page) {
    await page.evaluate(() => window.__coralReady);
    await page.waitForLoadState('load').catch(() => {});
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        // quiet: nothing started in the last 400 ms, and what is still open has been open for over 1.5 s (a long poll or a stream is the app's own, not the page loading)
        const now = Date.now();
        const young = [...page.__open.values()].filter(t => now - t < 1500).length;
        if (young === 0 && now - page.__lastStart >= 400) break;
        await page.waitForTimeout(100);
    }
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.waitForTimeout(300);
}

const results = [];
const worlds = { seeded: { base: seededBase, state: await signedIn(seededBase, seededLink) } };
if (freshBase && freshLink) worlds.fresh = { base: freshBase, state: await signedIn(freshBase, freshLink) };

for (const theme of themes) {
    fs.mkdirSync(path.join(out, theme), { recursive: true });
    const ctxs = new Map();
    for (const entry of PAGES) {
        if (only && !only.has(entry.id)) continue;
        const world = worlds[entry.world];
        for (const w of WIDTHS) {
            if (widthNames && !widthNames.has(w.name)) continue;
            if (entry.widths && !entry.widths.includes(w.name)) continue;
            const file = `${entry.id}__${w.name}.png`;
            const rec = { id: entry.id, width: w.name, theme, file: `${theme}/${file}`, ok: false, notes: entry.notes || '', stub: entry.stub || '' };
            if (!world) { rec.error = `no ${entry.world} server`; results.push(rec); continue; }
            let page;
            try {
                const key = `${entry.world}/${w.name}`;
                if (!ctxs.has(key)) { // one context for a world at a width: the page files are cached, so the next page loads fast; every page still opens in a page of its own
                    const c = await browser.newContext({
                        storageState: world.state, viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
                        isMobile: w.mobile, hasTouch: w.mobile, locale: 'en-US', timezoneId: 'UTC',
                        ...(w.mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' } : {}),
                    });
                    c.setDefaultTimeout(10000);
                    ctxs.set(key, c);
                }
                const ctx = ctxs.get(key);
                page = await ctx.newPage();
                page.__base = world.base;
                page.__open = new Map(); page.__lastStart = Date.now();
                page.on('request', r => { if (!['websocket', 'eventsource'].includes(r.resourceType())) { page.__open.set(r, Date.now()); page.__lastStart = Date.now(); } });
                const done = r => page.__open.delete(r);
                page.on('requestfinished', done); page.on('requestfailed', done);
                await page.clock.setFixedTime(FIXED_TIME);
                await page.addInitScript(t => { try { localStorage.setItem('coral-theme', t); } catch {} }, theme);
                if (entry.stub) { const s = STUBS[entry.stub]; await page.route('**/api/**', route => (route.request().method() === 'GET' && s.match(route.request().url()) ? route.fulfill({ json: s.body }) : route.fallback())); }
                if (entry.open) await OPENERS[entry.open](page, seed, entry);
                else {
                    await page.goto(world.base + fill(entry.path), { waitUntil: 'domcontentloaded' });
                }
                if (/^\/agents\/[0-9a-f-]{36}/.test(entry.path || '')) await page.evaluate(id => window.__coralReady.agentSelected(id), fill(entry.path).match(/[0-9a-f-]{36}/)[0]).catch(() => {});
                await settle(page);
                await page.screenshot({ path: path.join(out, theme, file), fullPage: true, animations: 'disabled', caret: 'hide' });
                rec.ok = true;
                rec.url = page.url().replace(world.base, '');
                rec.sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, theme, file))).digest('hex');
                rec.bytes = fs.statSync(path.join(out, theme, file)).size;
            } catch (e) {
                rec.error = String(e.message || e).split('\n')[0].slice(0, 240);
                log('FAILED', entry.id, w.name, theme, rec.error);
            } finally {
                if (page) await page.close().catch(() => {});
            }
            results.push(rec);
        }
        log(entry.id, results.filter(r => r.id === entry.id && r.theme === theme).map(r => (r.ok ? 'ok' : 'FAIL')).join(' '));
    }
    for (const c of ctxs.values()) await c.close().catch(() => {});
}
await browser.close();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ widths: WIDTHS.map(w => w.name), themes, results }, null, 2));
const bad = results.filter(r => !r.ok);
log(`${results.length - bad.length} of ${results.length} shots; ${bad.length} failed`);
