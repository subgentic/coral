// #15770: Check now while a check already runs (the updater's check lock is held while it downloads) said "Could not check for updates." once per press. A check already running is said in words
// ("Already checking: downloading Coral 2.0.66"), a press a moment after another is said calmly, only a real failure is an error; the card draws a disabled Check now while a check runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const api = await importUi('update_api');

let reply = () => new Response('{}', { status: 202 });
globalThis.fetch = window.fetch = async () => reply();

test('the answers to a press are told apart: started, busy, too soon, failed', async () => {
    api.serverHas.check = true;
    reply = () => Response.json({ ok: true }, { status: 202 });
    assert.deepEqual(await api.requestCheckNow(), { ok: true, busy: false, tooSoon: false });
    reply = () => Response.json({ code: 'busy', error: 'a check is already running' }, { status: 409 });
    assert.deepEqual(await api.requestCheckNow(), { ok: false, busy: true, tooSoon: false });
    reply = () => Response.json({ code: 'too_soon' }, { status: 429 });
    assert.deepEqual(await api.requestCheckNow(), { ok: false, busy: false, tooSoon: true });
    reply = () => Response.json({ code: 'switch_off' }, { status: 409 });
    assert.deepEqual(await api.requestCheckNow(), { ok: false, busy: false, tooSoon: false }, 'another 409 is not "busy"');
    reply = () => { throw new Error('offline'); };
    assert.deepEqual(await api.requestCheckNow(), { ok: false, busy: false, tooSoon: false });
});

test('the toast: none when it started, calm words for busy and too soon, an error only for a failure', () => {
    const s = { latest: '2.0.66', progress: null, staged: null };
    assert.equal(api.checkAnswerToast({ ok: true }, s), null);
    assert.deepEqual(api.checkAnswerToast({ ok: false, busy: true }, s), { text: 'Already checking: downloading Coral 2.0.66.', error: false });
    assert.deepEqual(api.checkAnswerToast({ ok: false, busy: true }, { ...s, progress: 40 }), { text: 'Already checking: downloading Coral 2.0.66 (40 percent).', error: false });
    assert.deepEqual(api.checkAnswerToast({ ok: false, busy: true }, {}), { text: 'Already checking.', error: false }, 'no version known: no version named');
    assert.equal(api.checkAnswerToast({ ok: false, tooSoon: true }, s).error, false);
    assert.deepEqual(api.checkAnswerToast({ ok: false }, s), { text: 'Could not check for updates.', error: true });
});

test('the status carries checking, and the card words it with the version', () => {
    const base = { enabled: true, installed: '2.0.65', state: 'none' };
    assert.equal(api.normalizeStatus({ ...base, checking: true }).checking, true);
    assert.equal(api.normalizeStatus({ ...base }).checking, false);
    assert.equal(api.normalizeStatus({ ...base, checking: 'yes' }).checking, false, 'only a real true');
    const w = api.checkingWords({ staged: { version: '2.0.66' }, progress: 12 });
    assert.equal(w.title, 'Checking for updates…');
    assert.match(w.sub, /Already checking: downloading Coral 2\.0\.66 \(12 percent\)/);
});
