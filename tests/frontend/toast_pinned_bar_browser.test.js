// #9298 (Automations audit #6): a toast is never over a page's pinned action bar, even when the bar appears after the toast (a created job opens its page, whose Edit, Pause and More are the bar at the foot), and a
// created or updated job says so on its page, in words ("Created. Next run today 06:00 your time."), once, under the title; its toast does not say it a second time to a screen reader. 1280 and 390.
// Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 820, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__coralReady.startup('liveList','settings')`);
            // 1. the bar appears after the toast
            await ev(`import((window.__coralStatic || '/static/') + 'notifications.js').then(m => { m.showToast('Job deleted'); return true; })`);
            await waitFor(`!!document.querySelector('#toast-host .toast')`, `${label}: the toast`, 5000);
            await ev(`(() => { const bar = document.createElement('div'); bar.className = 'item-bar'; bar.id = 'zz-bar'; bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:56px;z-index:1;'; bar.innerHTML = '<button class="btn">More</button><button class="btn">Edit</button>'; document.body.append(bar); return true; })()`);
            await waitFor(`(() => { const t = document.querySelector('#toast-host .toast'), b = document.getElementById('zz-bar'); if (!t || !b) return false; const a = t.getBoundingClientRect(), c = b.getBoundingClientRect(); return a.bottom <= c.top + 1 || ${mobile}; })()`, `${label}: the toast moves clear of a bar that appears after it`, 3000);
            await settle(500); // the toast slides in
            const clear = await ev(`(() => { const t = document.querySelector('#toast-host .toast').getBoundingClientRect(), b = document.getElementById('zz-bar').getBoundingClientRect(); return !(t.right > b.left && t.left < b.right && t.bottom > b.top && t.top < b.bottom); })()`);
            assert.equal(clear, true, `${label}: the toast does not cover the pinned bar`);
            await shot(`toast-bar-${label}`);
            await ev(`document.getElementById('zz-bar').remove(); document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); true`);
            // 2. a created job says so on its page
            await ev(`(() => { const at = new Date(Date.now() + 3 * 3600000).toISOString(); window.__job = { id: 7, name: 'greet-hourly', enabled: true, schedule_type: 'cron', cron_expr: '0 * * * *', next_fire_at: at, max_duration_s: 1800, repo_path: '/repo', prompt: 'Say hello', last_run: null, cleanup_worktree: false };
                const real = window.fetch; window.fetch = (u, o) => /\\/api\\/scheduled\\/jobs(\\?|$)/.test(String(u && u.url || u)) && (!o || !o.method || o.method === 'GET') ? Promise.resolve(new Response(JSON.stringify({ jobs: [window.__job] }), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'notifications.js').then(m => { m.showToast('Job created', false, undefined, { silent: true }); return true; })`); // a toast first, then the page that has the bar (any toast shown as a job page opens: the audit's "Job created" over More, Edit and Pause); creating a job itself now shows no toast, its page says it
            await ev(`document.dispatchEvent(new CustomEvent('job-saved', { detail: { id: 7, saved: 'created' } })); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-saved')`, `${label}: the job page says it was created`, 8000);
            const line = await ev(`(() => { const p = document.querySelector('#scheduler-detail .sched-saved'); return { text: p.textContent.trim(), role: p.getAttribute('role'), after: p.previousElementSibling && p.previousElementSibling.className }; })()`);
            assert.match(line.text, /^Created\. Next run .+ your time\.$/, `${label}: the words: ${line.text}`);
            assert.equal(line.role, 'status'); assert.match(line.after, /sched-status-line/, 'it sits under the title and its status line');
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-actions')`, `${label}: the job page's pinned bar`, 5000);
            await settle(700);
            const over = await ev(`(() => { const t = document.querySelector('#toast-host .toast'), b = document.querySelector('#scheduler-detail .sched-actions'); if (!t) return 'no toast'; const a = t.getBoundingClientRect(); return [...b.querySelectorAll('button')].filter(x => x.getClientRects().length).filter(x => { const c = x.getBoundingClientRect(); return a.right > c.left && a.left < c.right && a.bottom > c.top && a.top < c.bottom; }).map(x => x.textContent.trim()); })()`);
            assert.ok(over === 'no toast' || over.length === 0, `${label}: the toast is not over the job page's actions: ${JSON.stringify(over)}`);
            await shot(`job-created-${label}`);
            // it is said once: opening the job again does not repeat it
            await ev(`import((window.__coralStatic || '/static/') + 'scheduler.js').then(m => m.selectScheduledJob(7)); true`);
            await settle(300);
            assert.equal(await ev(`!!document.querySelector('#scheduler-detail .sched-saved')`), false, `${label}: said once`);
            console.log(`   ok   ${label}`);
        }
        console.log('toast_pinned_bar_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
