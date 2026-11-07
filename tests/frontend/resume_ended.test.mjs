// resume_ended.js (#14172, #14208): the words and the one-after-another resume of the members Wake Team found ended. Plain text only; a start that fails does not stop the rest.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

process.env.CORAL_TELEMETRY_DISABLED = '1';
const dom = installDom({ mode: 'local' });
const m = await importUi('resume_ended');

test('a session is trusted only when every part is a plain word', () => {
    assert.deepEqual(m.endedSessionOf({ agent_type: 'claude', session_id: 'abc-123', name: 'Dev One' }), { agentType: 'claude', sid: 'abc-123', name: 'Dev One' });
    assert.equal(m.endedSessionOf({ agent_type: 'claude', session_id: '../etc', name: 'x' }), null, 'a path is not an id');
    assert.equal(m.endedSessionOf({ agent_type: 'Claude Code', session_id: 'a', name: 'x' }), null);
    assert.equal(m.endedSessionOf({ agent_type: 'claude', session_id: 'a', name: '  ' }), null);
    assert.equal(m.endedSessionOf(null), null);
});

test('the question and the result say who and what', () => {
    assert.equal(m.resumeEndedQuestion('crew', ['Lead']), 'Lead was ended in "crew", so Wake does not apply. Resume it? Each starts again in its own folder with its earlier chat; a resume does not bring back its role\'s capabilities or Keep Full access. Agents you ended one at a time are listed too.');
    assert.match(m.resumeEndedQuestion('crew', ['Lead', 'Dev', 'QA']), /^Lead, Dev and QA were ended in "crew".* Resume them\?/);
    assert.equal(m.resumeEndedWords('crew', { resumed: ['Lead', 'Dev'], failed: [] }), 'Lead and Dev are back in "crew".');
    assert.equal(m.resumeEndedWords('crew', { resumed: ['Lead'], failed: [{ name: 'QA', why: 'its folder is gone' }] }), 'Lead is back in "crew". QA did not start: its folder is gone');
    assert.equal(m.resumeEndedWords('crew', { resumed: [], failed: [] }), 'Nothing to resume in "crew".');
});

test('each ended member is resumed in turn on the team\'s computer, and a failure does not stop the rest', async () => {
    const calls = [];
    globalThis.fetch = window.fetch = async (url, opts = {}) => {
        const u = String(url); calls.push({ u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        if (u.endsWith('/resume-info')) {
            const sid = decodeURIComponent(u.split('/history/')[1].split('/')[0]);
            if (sid === 'gone') return Response.json({ working_dir: '/work/x', working_dir_exists: false, agent_type: 'claude' });
            return Response.json({ working_dir: '/work/crew', working_dir_exists: true, agent_type: 'claude', display_name: sid === 'a-lead' ? 'Lead' : 'Dev', permission_mode: 'default', resume_session_id: sid });
        }
        if (u === '/api/sessions/launch') return Response.json({ ok: true });
        return Response.json({}, { status: 404 });
    };
    const out = await m.resumeEndedAgents('local', [
        { agent_type: 'claude', session_id: 'a-lead', name: 'Lead' },
        { agent_type: 'claude', session_id: 'gone', name: 'Dev' },
        { agent_type: 'claude', session_id: 'a-qa', name: 'QA' },
        { agent_type: 'bad type', session_id: 'x', name: 'Ignored' },
    ], 'b-board');
    assert.deepEqual(out.resumed, ['Lead', 'QA']);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].name, 'Dev');
    assert.match(out.failed[0].why, /folder it worked in is gone/);
    const launches = calls.filter(c => c.u === '/api/sessions/launch').map(c => c.body);
    assert.equal(launches.length, 2, 'the missing folder started nothing');
    assert.deepEqual(launches[0], { working_dir: '/work/crew', agent_type: 'claude', resume_session_id: 'a-lead', display_name: 'Lead', board_id: 'b-board', board_name: 'b-board', permission_mode: 'default' });
});

test.after(() => dom.window.close());
