// #21635: the template browser's three reads (categories, templates in a category, one template) took any answer as data. A 502's error object reached the preview
// and was drawn as a template. Each now checks resp.ok: the toast and the "Failed to load template" text the code already had. The reads are stubbed.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { BASE } = require('./test_base');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, ev, waitFor } = await connect();
    try {
        await Page.enable();
        { const loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady(ev); }
        const run = (failing) => ev(`(async () => {
            const S = (window.__coralStatic || '/static/');
            window.__failing = ${JSON.stringify(failing)};
            if (!window.__tplWrapped) { window.__tplWrapped = true; const inner = window.fetch; window.fetch = (u, o) => {
                const url = String(u && u.url || u); if (!/\\/api\\/templates\\//.test(url)) return inner(u, o);
                const parts = url.split('/api/templates/')[1].split('?')[0].split('/');
                const level = parts.length; // 1 categories, 2 templates in a category, 3 one template
                const body = level === 1 ? [{ name: 'core' }] : level === 2 ? [{ name: 'alpha' }] : { name: 'alpha', body: 'Hello body' };
                const bad = window.__failing === level;
                return Promise.resolve(bad ? new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
            }; }
            document.getElementById('template-browser-modal')?.remove();
            document.querySelectorAll('.toast').forEach(t => t.remove());
            (await import(S + 'template_browser.js')).showTemplateBrowser('agents', () => {});
            return true;
        })()`);
        const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
        const toasts = () => ev(`[...document.querySelectorAll('.toast, [role="status"], [role="alert"]')].map(t => t.textContent).join('|')`);
        // a category read that fails: no categories (first: a good answer is kept for the page's life, so a later run would draw from that)
        await run(1);
        await waitFor(`!document.querySelector('.template-browser-categories .template-browser-loading')`, 'the category read to settle', 10000);
        assert.equal(await ev(`document.querySelectorAll('.template-cat-btn').length`), 0, 'a 502 on the categories draws none');
        assert.match(await toasts(), /Failed to load template categories/, 'and says so: ' + await toasts());
        // a template read that fails: the preview says so
        await run(3);
        await waitFor(`document.querySelector('.template-cat-btn')`, 'the category list', 10000);
        await ev(`document.querySelector('.template-cat-btn').click()`);
        await waitFor(`document.querySelector('.template-item-btn')`, 'the template list', 10000);
        await ev(`document.querySelector('.template-item-btn').click()`);
        await waitFor(`!document.querySelector('.template-browser-preview .template-browser-loading')`, 'the preview to settle', 10000);
        const preview = await text('.template-browser-preview');
        assert.match(preview, /Failed to load template/, 'a 502 on one template says so: ' + JSON.stringify(preview));
        // a list read that fails: no templates are drawn from the error object
        await run(2);
        await waitFor(`document.querySelector('.template-cat-btn')`, 'the category list', 10000);
        await ev(`document.querySelector('.template-cat-btn').click()`);
        await waitFor(`!document.querySelector('.template-browser-list .template-browser-loading')`, 'the list read to settle', 10000);
        assert.equal(await ev(`document.querySelectorAll('.template-item-btn').length`), 0, 'a 502 on the template list draws no templates');
        assert.match(await toasts(), /Failed to load templates/, 'and says so: ' + await toasts());
        console.log('PASS the template browser says it failed on a 502, for all three reads');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
