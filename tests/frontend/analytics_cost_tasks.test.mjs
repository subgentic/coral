import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({mode: 'local'});
try {
    const {createCostTaskReader} = await importUi('analytics_cost_tasks');
    const urls = [], first = Array.from({length: 100}, (_, id) => ({id, cost_usd: id}));
    const read = createCostTaskReader(async url => {
        urls.push(url);
        return Response.json(url.includes('&cursor=') ? {tasks: [{id: 100, cost_usd: 0}]} : {tasks: first, next_cursor: 'opaque/+='});
    });
    const tasks = await read();
    assert.equal(tasks.length, 101);
    assert.equal(tasks[100].cost_usd, 0);
    assert.ok(!urls[0].includes('has_cost'));
    assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('cursor'), 'opaque/+=');
    await assert.rejects(createCostTaskReader(async () => Response.json({tasks: [], next_cursor: 'same'}))(), /repeated/);
    let calls = 0;
    await assert.rejects(createCostTaskReader(async () => ++calls === 1 ? Response.json({tasks: first, next_cursor: 'next'}) : new Response('', {status: 500}))(), /unavailable/);
    first[0].cost_usd = 999;
    const beforePoll = urls.length;
    const polled = await read();
    assert.equal(urls.length - beforePoll, 1, 'automatic refresh reads only the first page');
    assert.equal(polled.length, 101, 'older tasks survive a first-page refresh');
    assert.equal(polled[0].cost_usd, 999, 'the first-page values are refreshed');
    const beforeFull = urls.length;
    await read({full: true});
    assert.equal(urls.length - beforeFull, 2, 'explicit Refresh can reload all pages');
    let release, count = 0;
    const concurrent = createCostTaskReader(() => {count++; return new Promise(r => {release = () => r(Response.json({tasks: []}));});});
    const one = concurrent(), two = concurrent(); release(); await Promise.all([one, two]);
    assert.equal(count, 1, 'overlapping polls share one read');
    console.log('analytics_cost_tasks: ok');
} finally {dom.close?.();}
