// #21185: saved document comments remain private until a single explicit batch.
// Exercises the real viewer/composer and draft controller, with transport fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const HEX = 'd'.repeat(64), OTHER = 'e'.repeat(64);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    // A person's hands, not the page's own methods (#21425: the comment box was visible and dead, and this suite clicked the hidden toggle in code and set .value, so it never saw it): the pointer goes to the middle of the element, and what is under it must BE the element.
    const realClick = async selector => {
        const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return { missing: true }; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: hit === e || e.contains(hit), covered: hit && (hit.id || hit.className || hit.tagName), rect: [r.left, r.top, r.width, r.height].map(Math.round).join(','), view: innerWidth + 'x' + innerHeight }; })()`);
        assert.ok(!at.missing, `${selector} is on the page`);
        assert.ok(at.ok, `${selector} can be pressed: under the pointer is ${at.covered}; box ${at.rect} in ${at.view}`);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: at.x, y: at.y });
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    };
    // The page's own redraw of a bar (the live tick draws a just-saved draft's Send bar once more) can replace the button between the mark and the click, as it can under a person's pointer: wait until the viewer has been still for 250 ms, then mark and click at once; a button still replaced is found again (twice at most), the click itself stays a real pointer click and its assertions stay.
    const stillFor = ms => ev(`new Promise(res => { const root = document.querySelector('#artifact-viewer') || document.body; let t = setTimeout(done, ${ms}); setTimeout(done, 3000); const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ${ms}); }); mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); function done() { mo.disconnect(); res(true); } })`);
    const realButton = async (label, scope = '#artifact-viewer') => {
        for (let attempt = 0; ; attempt++) {
            await stillFor(250);
            await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) throw Error('Missing button: ' + ${JSON.stringify(label)}); b.dataset.realclick = '1'; return true; })()`);
            try { await realClick('[data-realclick]'); break; } catch (e) { if (attempt >= 1 || !/is on the page/.test(String(e.message))) throw e; }
            finally { await ev(`document.querySelectorAll('[data-realclick]').forEach(b => delete b.dataset.realclick); true`); }
        }
    };
    const typeInto = async (selector, text) => { await realClick(selector); await Input.insertText({ text }); assert.equal(await ev(`document.querySelector(${JSON.stringify(selector)}).value`), text, 'typed words land in the box'); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
    const button = (label, scope = '#artifact-viewer') => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) throw Error('Missing button: ' + ${JSON.stringify(label)}); b.click(); return true; })()`);
    const fixture = `(() => {
        const real = fetch;
        window.__reviewRow = { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'Release plan', media_type: 'text/markdown', available: true, tags: ['for review'], team: 'draft-test', board_id: 'draft-test', produced_by: 'Frontend Dev', version: 2, created_at: new Date().toISOString() }; window.__drafts = []; window.__revision = 0; window.__writes = []; window.__batches = []; window.__unknown = false; window.__refuse = false; window.__seen = {}; window.__published = []; window.__decisions = []; window.__decisionReplay = null; window.__loseDecision = false;
        const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, options = {}) => {
            const url = new URL(String(u), location.href), method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : {};
            if (url.pathname === '/api/team-artifacts' && window.__reviewRow) return json(window.__reviewFixturePage(u, location.href, { 'draft-test': [{ ...window.__reviewRow, draft_count: window.__drafts.length }] }));
            if (url.pathname.endsWith('/review') && method === 'POST') {
                if (window.__decisionReplay) return json(window.__decisionReplay);
                window.__decisions.push(body); window.__drafts = []; window.__revision++;
                if (window.__loseDecision) { window.__loseDecision = false; window.__decisionReplay = { status: 'sent', request_id: body.send_drafts.request_id, replayed: true }; return Promise.reject(new TypeError('Decision response lost')); }
                return json({ state: body.decision === 'approve' ? 'approved' : 'changes', changed: true, tags: ['approved'], review: { state: body.decision === 'approve' ? 'approved' : 'changes' }, delivered: true, to: 'Builder', drafts_sent: true, batch: { status: window.__batchStatus || 'sent' } });
            }
            if (url.pathname.includes('/review-drafts')) {
                if (method === 'GET') return json({ drafts: url.pathname.includes('${OTHER}') ? [] : window.__drafts, revision: window.__revision, count: url.pathname.includes('${OTHER}') ? 0 : window.__drafts.length, drafts_supported: true, can_write: window.__writeAllowed !== false, can_send: window.__sendAllowed !== false, reason: window.__reason || '', targets: window.__targets || ['Builder'] });
                window.__writes.push({ url: url.pathname, method, body });
                if (url.pathname.endsWith('/send')) {
                    if (window.__refuse) return json({ code: window.__refuseCode || 'not_delivered', error: window.__refuseWords || 'Agent unavailable. Drafts kept.' }, 409);
                    if (window.__seen[body.request_id]) return json({ ...window.__seen[body.request_id], replayed: true });
                    if (body.revision !== window.__revision) return json({ code: 'stale_revision', error: 'Drafts changed. Reload before sending.' }, 409);
                    window.__batches.push(window.__drafts.map(d => ({ ...d })));
                    window.__published.push(...window.__drafts.map(d => ({ ...d, author: { kind: 'owner', subject: 'Operator' }, created_at: new Date().toISOString(), can: {} })));
                    window.__drafts = []; window.__revision++;
                    const result = { ok: true, status: 'sent', revision: window.__revision, remaining_count: 0 };
                    window.__seen[body.request_id] = result;
                    if (window.__unknown) { window.__unknown = false; return Promise.reject(new TypeError('Connection lost after delivery')); }
                    return json(result);
                }
                if (method === 'POST') { window.__drafts.push({ ...body, id: window.__revision + 1, source: 'owner' }); window.__revision++; return json({ draft: window.__drafts.at(-1), revision: window.__revision, count: window.__drafts.length }, 201); }
                const id = Number(url.pathname.split('/').at(-1));
                if (method === 'PATCH') window.__drafts = window.__drafts.map(d => d.id === id ? { ...d, body: body.body } : d);
                if (method === 'DELETE') window.__drafts = window.__drafts.filter(d => d.id !== id);
                window.__revision++; return json({ ok: true, revision: window.__revision });
            }
            if (url.pathname.includes('/api/artifacts/') && url.pathname.includes('/comments')) {
                if (method !== 'GET') { window.__writes.push({ url: url.pathname, method, body }); return json({ error: 'Published writes forbidden in draft fixture' }, 500); }
                return json({ comments: window.__published, locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true }, limits: { body: 8192 } });
            }
            if (url.pathname === '/api/artifacts/${HEX}' || url.pathname === '/api/artifacts/${OTHER}') return Promise.resolve(new Response('# Release plan\\n\\nVersion 2 · Frontend Dev\\n\\n## Before launch\\n\\nAssign an owner before launch. Confirm that the team can roll back the release.\\n\\n## Rollout\\n\\nMonitor the rollout. Pause if the error rate rises and confirm the review is finished.', { headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, options);
        }; return true;
    })()`;
    const open = async (hex, board = 'draft-test') => {
        await ev(`(async () => { const m = await import(${S} + 'artifact_viewer.js'); m.openArtifactViewer('${hex}', { filename: 'Release plan', board: ${JSON.stringify(board)} }); return true; })()`);
        await waitFor(`!!document.querySelector('.ac-composer textarea')`, 'document comments ready', 8000);
        if (hex === HEX && board === 'draft-test') await waitFor(`document.querySelector('#artifact-viewer').hasAttribute('data-document-review')`, 'Needs you review context');
        const state = await ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-panel'), r = p.getBoundingClientRect(); return { inert: p.inert, hidden: p.hidden, shown: r.width > 0 && r.height > 0, toggleShown: !!document.querySelector('#artifact-viewer .ac-toggle')?.getClientRects().length }; })()`);
        assert.deepEqual({ inert: state.inert, hidden: state.hidden, shown: state.shown }, { inert: false, hidden: false, shown: true }, 'the comments column is usable from the first paint: nothing opens it');
        await ev(framesJs(4));
    };
    const save = async text => {
        await typeInto('.ac-composer textarea', text);
        await realButton('Save draft');
        await waitFor(`document.querySelector('.ac-composer textarea')?.value === ''`, 'saved private draft', 5000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // A new browser, and one that remembers the comments shut from a document that was not a review (coral-artifact-comments-open): the review's comment box works at once, at both sizes, by a person's clicks and typing (#21425).
        for (const [width, height] of [[1600, 1000], [390, 844]]) for (const remembered of [null, 'closed']) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral-artifact-comments-open'); ${remembered ? `localStorage.setItem('coral-artifact-comments-open', '${remembered}');` : ''} true`);
            await ev(fixture); await open(HEX);
            const what = `${width}x${height}${remembered ? ', remembered shut' : ', fresh profile'}`;
            await typeInto('.ac-composer textarea', `Typed by hand at ${width}`);
            await realButton('Save draft');
            await waitFor(`window.__drafts.length === 1 && window.__drafts[0].body === 'Typed by hand at ${width}'`, `Save draft by a click (${what})`, 5000);
            assert.equal(await ev('window.__batches.length'), 0, 'Save never delivers');
            await shot(`draft-review-first-paint-${width}${remembered ? '-remembered' : ''}`);
            await waitFor(`!!document.querySelector('.ac-draft-bar:not([hidden])')`, `the saved draft shows its Send bar (${what})`, 5000);
            await realButton('Send comments');
            await waitFor(`window.__batches.length === 1 && window.__batches[0].length === 1`, `Send comments by a click (${what})`, 5000);
            await click('.artifact-viewer-close');
        }
        for (const width of [1280, 390]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await installAudit(ev); await setTheme(ev, theme); await ev(fixture); await open(HEX);
            await ev(`(() => { const p = [...document.querySelectorAll('.artifact-viewer-body p')].find(p => p.textContent.startsWith('Assign an owner')); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 29); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(r); document.dispatchEvent(new Event('selectionchange')); document.querySelector('.artifact-viewer-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('.ac-selbtn:not([hidden])')`, 'select a quoted passage');
            await click('.ac-selbtn');
            await save('First private comment');
            assert.ok(await ev(`window.__drafts[0].anchor.quote.includes('Assign an owner')`), 'saved draft keeps the selected quote');
            assert.equal(await ev('window.__batches.length'), 0, 'Save must never deliver');
            assert.equal(await ev('window.__published.length'), 0, 'Save must not publish');
            await save('Second private comment');
            assert.equal(await ev('window.__drafts.length'), 2);
            await save('Temporary draft to delete');
            await waitFor(`document.querySelectorAll('.ac-draft-card').length === 3`, 'temporary draft');
            await ev(`(() => { const cards = [...document.querySelectorAll('.ac-draft-card')]; [...cards.at(-1).querySelectorAll('button')].find(b => b.textContent === 'Delete').click(); return true; })()`);
            await waitFor(`window.__drafts.length === 2 && document.querySelectorAll('.ac-draft-card').length === 2`, 'private delete');
            await waitFor(`!!document.querySelector('.ac-draft-card button:not(:disabled)')`, 'draft actions ready');
            await button('Edit');
            await ev(`document.querySelector('.ac-draft-card textarea').value = 'Discard this edit'; true`);
            await button('Cancel edit');
            await waitFor(`!document.querySelector('.ac-draft-card textarea')`, 'edit cancelled');
            assert.equal(await ev('window.__drafts[0].body'), 'First private comment');
            await waitFor(`!!document.querySelector('.ac-draft-card button:not(:disabled)')`, 'draft actions ready');
            await button('Edit');
            await ev(`document.querySelector('.ac-draft-card textarea').value = 'Edited private comment'; true`);
            await button('Save draft');
            await waitFor(`window.__drafts[0].body === 'Edited private comment'`, 'edited draft saved');
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            assert.equal(await ev(`document.querySelector('.ac-draft-recipients').textContent`), 'To: Builder', 'recipient shown before sending');
            await shot(`draft-review-${width}-${theme}`);
            await ev(`document.querySelector('.ac-panel > .ac-composer').scrollIntoView({ block: 'end' }); true`);
            await shot(`draft-review-composer-${width}-${theme}`);
            const layout = await ev(`(() => { const p = document.querySelector('.ac-panel'), b = document.querySelector('.ac-draft-bar'); const r = b.getBoundingClientRect(); return { overflow: p.scrollWidth > p.clientWidth + 1, width: r.width, right: r.right, fullWidth: Math.abs(r.width - document.querySelector('.artifact-viewer-content').clientWidth) < 3, outside: !p.contains(b) }; })()`);
            assert.ok(layout.fullWidth && layout.outside, 'review bar spans the workspace outside the scrolling comments');
            assert.equal(layout.overflow, false, 'draft panel has no horizontal overflow');
            assert.ok(layout.width > 0 && layout.right <= width + 1);
            const audit = await auditRegion(ev, ['.ac-review-drafts']); assert.deepEqual(audit.fails, [], 'draft text contrast');
            await click('.artifact-viewer-close');
            await waitFor(`document.body.textContent.includes('Leave document?')`, 'leave reminder');
            await shot(`draft-review-leave-${width}-${theme}`);
            await button('Leave and keep drafts', '#confirm-modal');
            await waitFor(`document.querySelector('#artifact-viewer').hidden`, 'leave keeps drafts');
            assert.equal(await ev('window.__drafts.length'), 2);
            await ev(`(async () => { window.switchNavTab('hub-inbox'); const reviews = await import(${S} + 'inbox_reviews.js'); reviews.reviewsChangedOnServer(); await reviews.refreshReviews(true); const tabs = await import(${S} + 'inbox_tab.js'); await tabs.selectInboxTab('needs'); return true; })()`);
            try { await waitFor(`document.querySelector('#group-table-view')?.textContent.includes('2 comments not sent · Draft review')`, 'Inbox retains the draft count'); }
            catch (error) { console.error('Inbox state', await ev(`({ text: document.querySelector('#group-table-view')?.textContent, rows: window.__reviewRow, draftCount: window.__drafts.length })`)); await shot('inbox-debug'); throw error; }
            if (width === 390) assert.ok(await ev(`(() => { const count = document.querySelector('.inbox-phone-meta .inbox-draft-count'), first = count?.parentElement.firstElementChild; return !!count && count.getBoundingClientRect().top >= first.getBoundingClientRect().bottom - 1; })()`), 'phone draft count has its own line below the metadata');
            await shot(`draft-review-inbox-${width}-${theme}`);
            await open(OTHER);
            assert.equal(await ev('document.querySelectorAll(".ac-draft-card").length'), 0, 'another exact version cannot show these drafts');
            await click('.artifact-viewer-close');
            await open(HEX);
            await waitFor(`document.querySelectorAll('.ac-draft-card').length === 2`, 'saved drafts on reopen');
            await ev('window.__refuse = true; true'); await button('Send comments');
            await waitFor(`document.body.textContent.includes('Agent unavailable. Drafts kept.')`, 'delivery refusal');
            assert.equal(await ev('window.__drafts.length'), 2, 'failure keeps every draft');
            await ev('window.__refuse = false; window.__unknown = true; true'); await button('Send comments');
            await waitFor(`!![...document.querySelectorAll('.ac-draft-bar button')].find(b => b.textContent === 'Retry pending send')`, 'unknown outcome retry');
            await button('Retry pending send');
            await waitFor(`!document.querySelector('.ac-draft-card')`, 'same request confirms delivery');
            assert.equal(await ev('window.__batches.length'), 1, 'unknown outcome must not send twice');
            assert.equal(await ev('window.__batches[0].length'), 2, 'all comments in one batch');
            assert.equal(await ev(`window.__writes.some(w => !w.url.includes('/review-drafts'))`), false, 'never use a published comment fallback');
            const ids = await ev(`window.__writes.filter(w => w.url.endsWith('/send')).map(w => w.body.request_id)`);
            assert.equal(ids.at(-1), ids.at(-2), 'same UUID on retry');
            await shot(`draft-review-sent-${width}-${theme}`);
            await click('.artifact-viewer-close');
            await ev(`window.__published = []; window.__drafts = [{ id: 91, body: 'Imported root', source: 'gdoc', source_name: '<script>Google reviewer</script>\u202E' }, { id: 92, body: 'Imported reply', source: 'gdoc', source_name: 'Second reviewer', parent_draft_id: 91 }]; window.__revision++; true`);
            await open(HEX);
            assert.equal(await ev(`document.querySelector('.ac-review-drafts').textContent.includes('Reply to: Imported root')`), true, 'Google draft reply names its parent');
            assert.equal(await ev(`!!document.querySelector('.ac-review-drafts script')`), false, 'Google author is text');
            assert.ok(await ev(`document.querySelector('.ac-review-drafts').textContent.includes('U+202E')`), 'Google directional control is visibly marked');
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); document.querySelector('.ac-review-drafts').scrollIntoView({ block: 'start' }); true`);
            await shot(`draft-review-google-${width}-${theme}`);
            await ev(`window.__published.push({ id: 77, body: 'An agent thread to reply to', parent_id: null, author: { kind: 'agent', subject: 'Builder' }, can: { reply: true }, created_at: new Date().toISOString() }); true`);
            await open(HEX);
            await click('.ac-card[data-id="77"] .ac-replybox');
            await ev(`document.querySelector('.ac-composer textarea').value = 'Private reply to the agent'; true`);
            await button('Save draft');
            await waitFor(`window.__drafts.length === 3`, 'reply saved privately');
            assert.equal(await ev('window.__drafts.at(-1).parent_id'), 77, 'draft keeps the published reply reference');
            const approve = () => ev(`(async () => { const m = await import(${S} + 'artifact_review.js'); window.__decisionResult = null; window.__decisionError = null; m.approveRow('draft-test', { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'review.md', team: 'draft-test' }).then(r => window.__decisionResult = r, e => window.__decisionError = e.message); return true; })()`);
            await approve();
            await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, 'decision offers draft batch');
            await button('Back to review', '#confirm-modal');
            await waitFor(`!!window.__decisionError`, 'cancel returns to review');
            assert.equal(await ev('window.__decisions.length'), 0, 'cancel writes no decision');
            assert.equal(await ev('window.__drafts.length'), 3, 'cancel keeps Google drafts and private reply');
            await ev('window.__loseDecision = true; true');
            await approve();
            await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, 'combined approve offer');
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            await shot(`draft-review-decision-${width}-${theme}`);
            await button('Approve and send comments', '#confirm-modal');
            await waitFor(`!!window.__decisionError`, 'decision response lost');
            await approve();
            await waitFor(`!!window.__decisionResult`, 'same decision replay confirmed', 8000);
            assert.equal(await ev('window.__decisions.length'), 1, 'one combined decision');
            assert.ok(await ev('!!window.__decisions[0].send_drafts.request_id'));
            assert.equal(await ev('window.__drafts.length'), 0);
            await click('.artifact-viewer-close');
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(fixture);
        await ev(`window.__reviewRow = { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'review.md', available: true, tags: ['for review'], produced_by: 'Builder', created_at: new Date().toISOString() }; window.__batchStatus = 'queued'; true`);
        await open(HEX);
        await waitFor(`!!document.querySelector('.artifact-review-changes:not([hidden])')`, 'actual request changes control');
        await save('Draft included with changes');
        await click('.artifact-review-changes');
        await ev(`document.getElementById('artifact-review-text').value = 'Please revise the introduction.'; document.querySelector('.artifact-review-form').requestSubmit(); true`);
        await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, 'offer changes with drafts');
        await button('Back to review', '#confirm-modal');
        await waitFor(`document.querySelector('.artifact-review-error').textContent.includes('cancelled')`, 'cancelled changes');
        assert.equal(await ev('window.__decisions.length'), 0, 'cancelled changes sends nothing');
        assert.equal(await ev('window.__drafts.length'), 1);
        await ev(`document.querySelector('.artifact-review-form').requestSubmit(); true`);
        await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, 'changes retry offers batch');
        await button('Request changes and send comments', '#confirm-modal');
        await waitFor(`window.__decisions.length === 1`, 'one changes request');
        await waitFor(`document.body.textContent.includes('Queued for Builder')`, 'queue is shown honestly');
        assert.equal(await ev('window.__decisions[0].text'), 'Please revise the introduction.');
        assert.ok(await ev('!!window.__decisions[0].send_drafts.request_id'));
        assert.equal(await ev(`window.__writes.some(w => w.url.includes('/comments'))`), false, 'combined changes has no legacy comment fallback');
        await shot('draft-review-changes-queued');
        await ev(`(async () => {
            const { createDraftReview } = await import(${S} + 'artifact_review_drafts.js');
            const review = createDraftReview({ hex: '${HEX}', server: 'remote-test', board: 'draft-test' });
            await review.refresh(); await review.create({ body: 'A private remote draft', anchor: { whole: true }, images: [] });
            window.__remoteWrite = window.__writes.at(-1);
            window.__writeAllowed = false; window.__sendAllowed = false; await review.refresh();
            const count = window.__writes.length;
            try { await review.create({ body: 'Forbidden' }); } catch (error) { window.__remoteWriteRefused = error.message; }
            try { await review.send(); } catch (error) { window.__remoteSendRefused = error.message; }
            window.__remoteNoFallback = count === window.__writes.length;
            review.close(); return true;
        })()`);
        assert.ok((await ev('window.__remoteWrite.url')).startsWith('/api/remote/remote-test/api/artifacts/'), 'remote draft routes retain their computer');
        assert.ok(await ev('!!window.__remoteWriteRefused && !!window.__remoteSendRefused && window.__remoteNoFallback'), 'capability refusal never falls back to a local or published write');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(fixture);
        await ev(`window.__targets = ['Builder', 'QA', 'Designer', 'Reviewer']; true`); await open(HEX);
        await save('Review for multiple recipients');
        assert.equal(await ev(`document.querySelector('.ac-draft-recipients summary').textContent`), 'To: Builder, QA and 2 more');
        assert.equal(await ev(`document.querySelector('.ac-draft-recipients summary').title`), 'Builder, QA, Designer, Reviewer');
        await click('.ac-draft-recipients summary');
        assert.ok(await ev(`document.querySelector('.ac-draft-recipients').open`), 'full recipients expand on tap');
        assert.equal(await ev(`document.querySelector('.ac-draft-recipients > span').textContent`), 'Builder, QA, Designer, Reviewer');
        await shot('draft-review-recipients-expanded');
        await ev(`window.__drafts = []; window.__targets = ['the agent that uploaded it']; true`); await open(HEX, '~no-team');
        await save('A review for the sole uploader. ' + 'Review detail. '.repeat(50));
        assert.equal(await ev(`document.querySelector('.ac-draft-recipients').textContent`), 'To: the agent that uploaded it', 'old server uploader fallback remains visible');
        await ev(`window.__targets = ['Solo Builder']; true`); await open(HEX, '~no-team');
        assert.equal(await ev(`document.querySelector('.ac-draft-recipients').textContent`), 'To: Solo Builder', 'named uploader uses the server target');
        await shot('draft-review-no-team-named');
        for (const reason of ['no_uploader', 'ambiguous_uploader']) {
            await ev(`window.__reason = '${reason}'; window.__sendAllowed = false; true`); await open(HEX, '~no-team');
            assert.equal(await ev(`document.querySelector('.ac-draft-bar button').disabled`), true, 'no-team ambiguous or missing target cannot send');
            const message = await ev(`document.querySelector('.ac-draft-bar').textContent`);
            assert.ok(message.includes('Your drafts stay saved.') && !message.includes(reason), 'no-team refusal has plain words');
            assert.equal(await ev('window.__drafts.length'), 1);
            await shot(`draft-review-no-team-${reason}`);
        }
        await ev(`window.__reason = ''; window.__sendAllowed = true; true`); await open(HEX, '~no-team');
        await button('Send comments'); await waitFor(`window.__batches.length === 1 && !document.querySelector('.ac-draft-card')`, 'no-team batch confirmed');
        assert.equal(await ev(`window.__writes.find(write => write.url.endsWith('/send')).body.board`), '~no-team', 'no-team batch retains reserved board');
        assert.ok(await ev('window.__batches[0][0].body.length > 600'), 'the full review is retained beyond the short typed notice limit');
        if (process.env.CORAL_SCREENSHOT_DIR) {
            const mock = fs.readFileSync(require('node:path').resolve(__dirname, '../design/21185/draft-document-review.html'), 'utf8');
            await Page.navigate({ url: 'about:blank' }); await Page.loadEventFired();
            const tree = await Page.getFrameTree(); await Page.setDocumentContent({ frameId: tree.frameTree.frame.id, html: mock });
            for (const width of [1280, 390]) for (const theme of ['dark', 'light']) for (const state of ['drafts', 'leave', 'inbox', 'approve']) {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await ev(`document.body.classList.toggle('light', ${theme === 'light'}); document.querySelector('#state').value = '${state}'; document.querySelector('#state').dispatchEvent(new Event('change')); true`);
                await shot(`mock-${state}-${width}-${theme}`);
            }
        }
        console.log('PASS artifact draft review: private save/edit/cancel, exact version, durable leave, refusal, one batch, ambiguous retry, themes and widths');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
