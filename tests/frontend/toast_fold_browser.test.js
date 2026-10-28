// Toasts of one kind fold into one card (UI/UX's 170 consistency pass 2, item 4, task 7690): five "Restarting <name>..." toasts are one card that says "Restarting 5 agents" (its dismiss button named for the count, the count said
// once more to a screen reader, its time started again), on a phone the card is one compact line below the app bar and any visible sign-in banner and only the newest toast is drawn; a toast with no group is a card of its own. Drives Chrome over CDP through
// agent_view_harness.js at 390 px; the toasts come from the page's own showToast.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        const folded = await ev(`(async () => { const n = await import(${S} + 'notifications.js'); document.querySelectorAll('.toast').forEach(t => t.remove());
            const g = { key: 'restarting', text: c => 'Restarting ' + c + ' agents' }; const first = n.showToast('Restarting agent-1...', false, 600000, { group: g });
            const same = []; for (let i = 2; i <= 5; i++) same.push(n.showToast('Restarting agent-' + i + '...', false, 600000, { group: g }) === first);
            const other = n.showToast('Saved', false, 600000);
            return { same, cards: [...document.querySelectorAll('.toast')].map(t => t.querySelector('.toast-message').textContent), label: first.querySelector('.toast-close').getAttribute('aria-label'), said: document.getElementById('notice-live').textContent }; })()`);
        assert.deepEqual(folded.same, [true, true, true, true], 'the next four of its kind are the same card');
        assert.deepEqual(folded.cards, ['Restarting 5 agents', 'Saved'], 'one card that counts, and a toast with no group is its own');
        assert.equal(folded.label, 'Dismiss: Restarting 5 agents', 'its dismiss button is named for the count');
        await ev(`document.querySelectorAll('.toast').forEach(t => { if (t.textContent.startsWith('Saved')) t.remove(); }); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].every(e => e.getAnimations().length === 0) && document.querySelector('.toast').getClientRects().length > 0`, 'the card to settle', 5000);
        const measure = `(() => { const t = document.querySelector('.toast'), b = t.getBoundingClientRect(), bar = document.querySelector('header.top-bar').getBoundingClientRect(), banner = document.getElementById('local-auth-banner');
            // what the card sits under: the app bar, a visible banner, the phone's list title (#10052) and a text field above it (#10458): the card is the first thing below all of them
            const above = [document.getElementById('local-auth-banner'), document.querySelector('.mobile-list-title'), ...document.querySelectorAll('input.field, input[type=search], input[type=text], select, textarea')].filter(e => e && e.getClientRects().length && !t.contains(e)).map(e => e.getBoundingClientRect().bottom).filter(v => v <= b.top + 1);
            const edge = Math.max(bar.bottom, ...above);
            return { top: Math.round(b.top - edge), h: Math.round(b.height), w: Math.round(b.width), vw: innerWidth, one: t.querySelector('.toast-message').scrollHeight <= t.querySelector('.toast-message').clientHeight + 1 }; })()`;
        const compact = card => assert.ok(card.top >= 0 && card.top <= 16 && card.h <= 56 && card.w < card.vw - 80 && card.one, 'one compact line below the header and visible banner: ' + JSON.stringify(card));
        compact(await ev(measure));
        await shot('toast-folded');
        const bannerDisplay = await ev(`(() => { const b = document.getElementById('local-auth-banner'); if (!b || !b.getClientRects().length) return null; const before = b.style.display; b.style.display = 'none'; return before; })()`);
        if (bannerDisplay !== null) {
            await waitFor(`(${measure}).top >= 0 && (${measure}).top <= 16`, 'toast moves below the app bar when the banner hides', 4000);
            compact(await ev(measure));
            await ev(`document.getElementById('local-auth-banner').style.display = ${JSON.stringify(bannerDisplay)}; true`);
            await waitFor(`(${measure}).top >= 0 && (${measure}).top <= 16`, 'toast clears the restored banner', 4000);
        }
        await ev(`import(${S} + 'notifications.js').then(n => { n.showToast('Restarting agent-6...', false, 600000, { group: { key: 'restarting', text: c => 'Restarting ' + c + ' agents' } }); return true; })`);
        assert.equal(await ev(`document.querySelectorAll('.toast').length`), 1, 'a sixth restart is still the one card');
        assert.equal(await ev(`document.querySelector('.toast-message').textContent`), 'Restarting 6 agents', 'and it says 6');
        await ev(`document.querySelector('.toast-close').click(); true`);
        const after = await ev(`import(${S} + 'notifications.js').then(n => { n.showToast('Restarting agent-7...', false, 600000, { group: { key: 'restarting', text: c => 'Restarting ' + c + ' agents' } }); return document.querySelector('.toast-message').textContent; })`);
        assert.equal(after, 'Restarting agent-7...', 'after the card is dismissed the next restart starts a new one at one');
        const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'restart_flow.js'), 'utf8');
        assert.ok(src.includes("group: { key: 'restarting', text: n => `Restarting ${n} agents` }"), 'Restart sends its toast as the "restarting" group: ' + src.length);
        // an error is never covered by a later ordinary toast: a failed save is not read as "Saved" (QA Reviewer 2, #7690)
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); import(${S} + 'notifications.js').then(n => { n.showToast('Could not save: the disk is full', true, 600000); n.showToast('Saved', false, 600000); return true; })`);
        await waitFor(`document.querySelectorAll('.toast.toast-front').length === 1`, 'one toast in front', 3000);
        const front = () => ev(`[...document.querySelectorAll('.toast')].filter(t => t.getClientRects().length > 0).map(t => t.querySelector('.toast-message').textContent)`);
        assert.deepEqual(await front(), ['Could not save: the disk is full'], 'the error stays drawn over the later "Saved"');
        await ev(`document.querySelector('.toast.error .toast-close').click(); true`);
        await waitFor(`document.querySelectorAll('.toast.toast-front').length === 1`, 'the next toast in front', 3000);
        assert.deepEqual(await front(), ['Saved'], 'and "Saved" is drawn once the error is dismissed');
        console.log('PASS toast fold');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
