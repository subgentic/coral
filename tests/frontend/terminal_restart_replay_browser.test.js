// #13421: wake with no browser attached, then render an empty-log capture at
// 137x42. Snapshot rows start at column zero; a reconnect repairs a dead pipe.
const assert = require('node:assert/strict');
require('./helpers/requires_tmux')('terminal_restart_replay_browser');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('./helpers/child_process');
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const SOCK = process.env.CORAL_TEST_TMUX_SOCKET;
assert.ok(SOCK && !SOCK.includes('/.coral/'), 'only the isolated test socket');
const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8', env: { ...process.env, TMUX: '', TMUX_PANE: '' } });
const key = fs.readFileSync(path.join(process.env.CORAL_TEST_DATA_DIR, 'api_key'), 'utf8').trim();
const api = async (method, route, body) => {
    const r = await fetch(BASE + route, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
};
const until = async (check, label) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
    throw new Error('timed out: ' + label);
};
const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-probe-'));
    let standIn;
    try {
        standIn = await launchStandIn(api, { displayName: 'Restart replay probe' });
        assert.ok(standIn.token, standIn.diag);
        const cli = (await api('GET', '/api/settings')).data.settings.cli_path_claude;
        assert.ok(cli.includes('coral-standin-'), 'replace only this helper-owned stand-in');
        const sizeFile = path.join(dir, 'size');
        fs.writeFileSync(cli, [
            '#!/bin/sh',
            'case "$1" in --version) echo "0.0.0 (stand-in)"; exit 0;; auth) echo \'{"loggedIn":true}\'; exit 0;; esac',
            `size() { stty size > ${q(sizeFile)}; }`, 'trap size WINCH', 'size',
            String.raw`printf '\033[2J\033[HREPLAY_ALPHA\r\nREPLAY_BETA\r\nREPLAY_GAMMA\r\n'`,
            String.raw`while :; do if IFS= read -r line; then case "$line" in probe) printf 'RECOVERED_STREAM\r\n';; esac; fi; done`, ''
        ].join('\n'), { mode: 0o755 });
        const slept = await api('POST', `/api/sessions/live/${standIn.sid}/sleep`, {});
        assert.equal(slept.data.ok, true, JSON.stringify(slept));
        const woke = await api('POST', `/api/sessions/live/${standIn.sid}/wake`, {});
        assert.equal(woke.data.ok, true, JSON.stringify(woke));
        await until(() => fs.existsSync(sizeFile), 'stand-in starts before any browser attaches');
        tmux('resize-window', '-t', `=${standIn.name}:`, '-x', '137', '-y', '42');
        await until(() => fs.readFileSync(sizeFile, 'utf8').trim() === '42 137', 'program receives 137x42');
        const capture = () => tmux('capture-pane', '-t', `=${standIn.name}:`, '-p', '-e');
        await until(() => capture().includes('REPLAY_GAMMA'), 'program screen is complete');
        const log = path.join(process.env.CORAL_TEST_DATA_DIR, 'logs', `claude-${standIn.sid}.log`);
        tmux('pipe-pane', '-t', `=${standIn.name}:`);
        fs.writeFileSync(log, '');
        await Page.enable();
        // A viewer follows the shared pane without resizing it, so the snapshot
        // and program dimensions stay at the observed 137x42 throughout attach.
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.selectLiveSession === 'function'`, 'dashboard');
        await waitFor(`matchMedia('(max-width: 767px)').matches`, 'viewer layout');
        await ev(`setLiveViewMode('terminal'); selectLiveSession(${JSON.stringify(standIn.name)}, 'claude', ${JSON.stringify(standIn.sid)}, 'local'); true`);
        const modulePath = `(window.__coralStatic || '/static/') + 'xterm_renderer.js'`;
        await waitFor(`(async()=>{const m=await import(${modulePath});return m.isTerminalWsOpen()&&m.getTerminal()?.cols===137&&m.getTerminal()?.rows===42&&m.terminalScreenText().includes('REPLAY_GAMMA')})()`, 'captured replay at 137x42', 15000);
        const rows = await ev(`(async()=>{const t=(await import(${modulePath})).getTerminal();return Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString(true)||'')})()`);
        for (const marker of ['REPLAY_ALPHA', 'REPLAY_BETA', 'REPLAY_GAMMA']) assert.equal(rows.find(s => s.includes(marker))?.indexOf(marker), 0, `${marker} must start in column zero, not staircase: ${JSON.stringify(rows)}`);
        assert.equal(fs.readFileSync(sizeFile, 'utf8').trim(), '42 137', 'the program width equals xterm, so correct dimensions cannot mask replay corruption');
        await ev(`window.disconnectTerminalWs(); true`);
        tmux('pipe-pane', '-t', `=${standIn.name}:`); fs.writeFileSync(log, '');
        await ev(`window.connectTerminalWs(${JSON.stringify(standIn.name)},'claude',${JSON.stringify(standIn.sid)},'local'); true`);
        await waitFor(`import(${modulePath}).then(m=>m.isTerminalWsOpen())`, 'reconnected socket');
        await ev(`import(${modulePath}).then(m=>m.sendTerminalInputWs(${JSON.stringify('probe\r')})).then(()=>true)`);
        await waitFor(`import(${modulePath}).then(m=>m.terminalScreenText().includes('RECOVERED_STREAM'))`, 'new live output after pipe repair', 10000);
        assert.ok(fs.readFileSync(log, 'utf8').includes('RECOVERED_STREAM'), 'new output reaches the real pipe log');
        console.log('PASS terminal_restart_replay: API-key wake without viewer, 137x42 program/xterm agreement, column-zero replay and restored live stream');
    } finally {
        try { await client.close(); } finally { if (standIn) await standIn.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
