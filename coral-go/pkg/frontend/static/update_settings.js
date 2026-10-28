import { plural } from './format.js';
/* Settings > Updates (#5275, design #5270): one status card (a dot, a line, a sentence, the action), the two switches, when it last looked, the version, and where Coral reaches. The pane is
 * drawn from the status each time it is shown. The switches are saved with Apply like the rest of Settings (applyUpdatePrefs); the card's buttons act at once: "Update and relaunch" opens the
 * confirmation (a dialog over this one), "Check now" asks the updater to look. A Homebrew or unsupported install says so and why, with the command to run. */
import { importOnce } from './import_once.js';
import { copyText, showToast } from './utils.js';
import { isCloud } from './server_base.js';
import { mountSettingsView } from './settings_view.js'; // the pane's rows (a startup module: the Settings rows draw from it)
const { actName, releaseNotesUrl, RELEASES_REPO, ageTier, canStart, installsLocally, notAvailable, reasonText, notReadyText, foundText, fetchHubRelaunch, requestCheckNow, savePrefs, saveChannel, serverHas } = await importOnce('./update_api.js');
const { HUB_RELAUNCH_ON, HUB_RELAUNCH_OFF, HUB_RELAUNCH_WINDOWS } = await importOnce('./update_words.js');
const { failureNotice, getUpdateStatus, refreshUpdateStatus, relaunchOffered } = await importOnce('./update_ui.js');

const { el: mk } = await importOnce('./dom_el.js');

let hubOn = null; // the hub switch as the server has it (GET /api/cloud/status), null when unknown
const body = () => document.getElementById('update-pane-body');

function stamp(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const d = new Date(t), now = new Date();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toDateString() === now.toDateString() ? `Today ${hm}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function card(s) {
    const c = mk('div', 'update-status'); c.setAttribute('role', 'group');
    const dot = mk('span', 'update-state-dot'); dot.setAttribute('aria-hidden', 'true');
    const text = mk('div', 'update-status-text');
    const title = mk('b'), sub = mk('p');
    text.append(title, sub);
    let act = null;
    const notice = failureNotice(s);
    if (s.relaunch.reason === 'applying' || s.state === 'applying') {
        title.textContent = 'Updating Coral…'; sub.textContent = 'The update is being installed. Coral restarts when it is done.'; dot.dataset.k = 'warm'; c.dataset.k = 'warm';
    } else if (notice) {
        title.textContent = notice.lead; sub.textContent = notice.rest.trim(); dot.dataset.k = 'bad'; c.dataset.k = 'bad';
        if (serverHas.check) act = mk('button', 'btn update-act', 'Try again'); // no server route to check now, no button
        if (act) act.type = 'button';
        if (act) act.addEventListener('click', async () => { act.disabled = true; await requestCheckNow(); await refreshUpdateStatus(); showUpdatesPane(); });
    } else if (relaunchOffered(s)) {
        const days = s.staged.days, tier = ageTier(days);
        title.textContent = `Coral ${s.staged.version} is ready`;
        sub.textContent = `Coral downloaded it and checked its signature ${days < 1 ? 'earlier today' : plural(days, 'day') + ' ago'}.`; // "Nothing is installed until you say yes" is in the ready notice and the dialog, not here too (#7360)
        dot.dataset.k = tier; c.dataset.k = tier;
        act = mk('button', 'btn btn-primary update-act', actName(s)); act.type = 'button'; // Windows installs from this page (#7338)
        act.setAttribute('aria-haspopup', 'dialog');
        if (windowsInstall(s) && !s.localInstall) { act = null; sub.textContent += ` ${reasonText(s.relaunch.reason)}`; } // a request through Coral Hub: nobody there can install, so no button (#7338)
        else if (!canStart(s)) { act.disabled = true; sub.textContent += ` ${notAvailable(s.relaunch.reason)}`; } // a real disabled button, not a primary one that only says so to a screen reader (#7338)
        if (act) act.addEventListener('click', async () => { if (act.disabled) return; (await importOnce('./update_dialog.js')).openUpdateDialog(getUpdateStatus()); });
        const notes = s.source === RELEASES_REPO ? releaseNotesUrl(s.staged.version) : ''; // what is in the update, on the one repository this page links to (#7360)
        if (notes) { const na = mk('a', 'update-notes-link', `What is new in ${s.staged.version}`); na.href = notes; na.target = '_blank'; na.rel = 'noopener noreferrer'; sub.append(' ', na); }
    } else if (s.progress !== null) {
        title.textContent = `Downloading Coral${s.staged && s.staged.version ? ' ' + s.staged.version : ''}`; sub.textContent = `${s.progress} percent`; dot.dataset.k = 'ok'; c.dataset.k = 'ok';
        const bar = mk('div', 'update-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(s.progress)); bar.setAttribute('aria-label', 'Download');
        const fill = mk('span'); fill.style.width = `${s.progress}%`; bar.append(fill); text.append(bar);
    } else {
        // Only the server's own reason says why nothing is ready (#5388): without it Coral does not claim to be up to date
        const t = notReadyText(s);
        title.textContent = t.title; sub.textContent = t.sub;
        if (s.notReady === 'up_to_date') { dot.dataset.k = 'ok'; c.dataset.k = 'ok'; } else if (s.notReady === 'check_failed' || s.notReady === 'rate_limited') { dot.dataset.k = 'warm'; c.dataset.k = 'warm'; }
        if (serverHas.check) act = mk('button', 'btn update-act', 'Check now');
        if (act) act.type = 'button';
        if (act) act.addEventListener('click', async () => { act.disabled = true; const ok = await requestCheckNow(); await refreshUpdateStatus(); showUpdatesPane(); if (!ok) showToast('Could not check for updates.', true); });
    }
    c.append(dot, text); if (act) c.append(act);
    return c;
}

/** Windows: an update installs from this computer's dashboard, after Windows asks the person (#166, #7338). The server says so with relaunch.reason, to everyone who asks. */
const windowsInstall = (s) => s.relaunch.reason === 'local_approval_needed';

/** Whether this install is one Coral does not update by itself: Homebrew, a folder it cannot write to, or whatever the server says is unsupported (its relaunch reason, since an older server sends no install kind). */
const isManaged = (s) => s.installKind === 'homebrew' || s.installKind === 'unwritable' || s.relaunch.reason === 'unsupported_install' || s.notReady === 'unsupported_install';

function managed(s) {
    const m = mk('div', 'update-managed'); m.setAttribute('role', 'group');
    const icon = mk('span', 'material-icons', 'info'); icon.setAttribute('aria-hidden', 'true');
    const t = mk('div');
    if (s.installKind === 'homebrew') {
        t.append(mk('b', null, 'Homebrew updates this Coral'), mk('p', null, 'Coral does not update itself when Homebrew installed it. To update, run:'));
        const cmd = mk('div', 'update-cmd'); const code = mk('code', null, s.upgradeCommand || 'brew upgrade --cask coral');
        const copy = mk('button', 'btn', 'Copy'); copy.type = 'button';
        copy.addEventListener('click', async () => { showToast((await copyText(code.textContent)) ? 'Copied' : 'Could not copy', false); });
        cmd.append(code, copy); t.append(cmd);
        t.append(mk('p', 'update-calm', 'Homebrew updates Coral; Coral does not update itself. Coral still shows a notice in this browser when a new version is out (Settings > General).'));
    } else {
        t.append(mk('b', null, 'This install cannot update itself'), mk('p', null, 'Coral can only update installs it can replace safely (the app, the installer or the archive from the releases page). Install the new release by hand.'));
        const a = mk('a', 'update-link', 'Open the releases page'); a.href = 'https://github.com/subgentic/coral/releases'; a.target = '_blank'; a.rel = 'noopener noreferrer'; t.append(a);
    }
    m.append(icon, t);
    return m;
}

// The page that runs the approval (Run workflow with the tag). A constant: no field the server or the release feed sent is ever put into this link.
let _hubForTests = null; // a test says it is the Hub without booting the Hub page
export function _setHubForTests(v) { _hubForTests = v; }
const inHub = () => (_hubForTests === null ? isCloud() : _hubForTests);

const APPROVE_URL = 'https://github.com/subgentic/coral/actions/workflows/approve-release.yml';
const daysSince = (iso) => { const t = Date.parse(iso); return t ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null; };
const ago = (d) => (d === null ? '' : d < 1 ? 'earlier today' : `${plural(d, 'day')} ago`);

/** The channel choice (#5558): Approved (the default) or Agentic, a radio field of the pane's settings_view. Through the Hub it is a line of text: the owner of that computer chooses. */
function channelFields(s) {
    if (inHub()) return [{ key: 'channel', type: 'custom', id: 'update-channel', label: 'Update channel', render: slot => { slot.classList.add('update-fact'); slot.textContent = `${s.channel === 'agentic' ? 'Agentic' : 'Approved'} (set on this computer)`; } }];
    const out = [{
        key: 'update-channel', type: 'radio', id: 'update-channel', wide: true, label: 'Update channel', help: 'Which releases Coral tells you about. Saved with Apply.', default: s.channel,
        options: [
            { value: 'approved', id: 'uc-approved', label: 'Approved (recommended)', help: 'Releases the team has approved.' },
            { value: 'agentic', id: 'uc-agentic', label: 'Agentic (every release)', help: 'Every release as soon as it is published, including ones not yet approved. These may change faster and be less tested.' },
        ],
    }];
    const lines = [];
    if (s.approved) { const d = daysSince(s.approved.approvedAt); lines.push(mk('p', 'update-calm', `Approved now: v${s.approved.version}${d === null ? '' : `, approved ${ago(d)}`}.`)); }
    if (s.pastApproved) lines.push(mk('p', 'update-calm', 'You are already past the Approved release, so Approved offers nothing newer.'));
    if (s.auto !== false) { const n = mk('p', 'update-calm update-channel-auto', 'Checking for updates automatically still uses Approved releases only.'); n.hidden = s.channel !== 'agentic'; lines.push(n); }
    if (lines.length) out.push({ key: 'channel_facts', type: 'notice', render: slot => slot.append(...lines) });
    out.push({ key: 'channel_waiting', type: 'notice', render: slot => slot.classList.add('update-waiting-slot') });
    return out;
}

/** The releases published but not yet approved (only those newer than the newest approved one), for the operator: collapsed, each with the tag to type and the one link to the approval page. Plain text only. */
function waitingBlock(s) {
    const d = mk('details', 'update-waiting');
    const sum = mk('summary', null, `Waiting for approval (${s.waiting.length})`);
    d.append(sum);
    d.append(mk('p', 'update-calm', 'Published, not yet approved. Approving makes a release the Approved channel, Homebrew and the download links. Only the repository\'s operator can: Coral does not approve anything itself.'));
    for (const r of s.waiting) {
        const days = daysSince(r.publishedAt);
        const tier = days === null ? 'ok' : ageTier(days) === 'stale' ? 'bad' : ageTier(days);
        const c = mk('div', 'update-status'); c.setAttribute('role', 'group'); c.dataset.k = tier;
        const dot = mk('span', 'update-state-dot'); dot.dataset.k = tier; dot.setAttribute('aria-hidden', 'true');
        const text = mk('div', 'update-status-text');
        text.append(mk('b', null, `Coral ${r.version}`), mk('p', null, days === null ? 'Waiting for approval' : `Published ${ago(days)}${days >= 7 ? ' (over a week)' : ''}, waiting for approval`));
        const how = mk('p', null, 'Run it with the tag '); how.append(mk('code', null, `v${r.version}`));
        text.append(how);
        if (r.notes) { const n = mk('details', 'update-notes'); n.append(mk('summary', null, 'Release notes'), mk('pre', null, r.notes)); text.append(n); }
        const a = mk('a', 'btn update-act', 'Open the approval page'); a.href = APPROVE_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', `Open the approval page for Coral ${r.version} on GitHub (opens a new tab)`);
        c.append(dot, text, a); d.append(c);
    }
    return d;
}

/** Draw the pane from the last status (and ask for a fresh one): the card, the channel and the facts are parts this module draws; the switch, the hub line and the facts are rows of a settings_view (the pane is Settings like the rest). */
export async function showUpdatesPane() {
    const host = body();
    if (!host) return;
    const s = getUpdateStatus() || await refreshUpdateStatus();
    hubOn = await fetchHubRelaunch();
    host.replaceChildren();
    if (!s || !s.enabled) { host.append(mk('p', 'update-calm', 'Updates are not available in this Coral.')); return; }
    const unmanaged = isManaged(s);
    const fields = [{ key: 'card', type: 'notice', render: slot => slot.append(unmanaged ? managed(s) : card(s)) }];
    if (s.hasChannel) fields.push(...channelFields(s));
    // Through Coral Hub the switch is not the hub's to change (the machine's owner sets it on that computer), so it is not drawn there
    const reason = unmanaged ? (s.installKind === 'homebrew' ? 'Homebrew manages updates.' : 'This install cannot update itself.') : '';
    if (!isCloud() && serverHas.autoPref) {
        const how = windowsInstall(s) ? 'Windows asks for your permission, and you choose when to install it.' : 'The update installs when you relaunch Coral, never while you work.';
        fields.push({
            key: 'auto', type: 'toggle', id: 'settings-update-auto', label: 'Check for updates automatically', default: unmanaged ? false : s.auto !== false, disabledWhen: () => unmanaged,
            help: unmanaged ? reason : { text: 'Downloads in the background and checks the release is genuine.', more: `${how} Only the latest releases of Coral's own GitHub repository are used.` },
        });
    }
    // The Coral Hub relaunch switch lives in Settings > Network and Hub (with the rest of what the hub may do here); this pane only says where it is
    if (!isCloud() && hubOn !== null && !unmanaged && s.hubRelaunch) { // Coral Hub's relaunch exists in this build (#7343)
        fields.push({
            key: 'hub_relaunch', type: 'custom', label: 'Relaunch from Coral Hub',
            // On Windows Coral Hub cannot install at all (the install asks the person here): the sentence says so and there is no switch to change (#7338)
            help: windowsInstall(s) ? HUB_RELAUNCH_WINDOWS : hubOn ? HUB_RELAUNCH_ON : HUB_RELAUNCH_OFF,
            render: slot => {
                if (windowsInstall(s)) return;
                const go = mk('button', 'btn btn-small', 'Change in Network and Hub'); go.type = 'button';
                go.addEventListener('click', () => window.showSettingsModal && window.showSettingsModal('network'));
                slot.append(go);
            },
        });
    }
    const fact = (key, label, value) => fields.push({ key, type: 'custom', label, render: slot => { slot.classList.add('update-fact'); slot.textContent = value; } });
    if (s.checkedAt) fact('checked', 'Last checked', stamp(s.checkedAt));
    if (s.checkedAt && foundText(s)) fact('found', 'What it found', foundText(s));
    fact('version', 'Version', s.installed || 'unknown');
    if (s.last && s.last.result === 'relaunched' && /^hub:/.test(s.last.by) && stamp(s.last.at)) fact('last', 'Last update', `Relaunched from Coral Hub at ${stamp(s.last.at)}`); // the time, never the hub user's name
    fields.push({ key: 'privacy', type: 'notice', render: slot => slot.append(mk('p', 'update-calm update-privacy', 'Coral contacts GitHub only, to read the release list and download the package.')) });
    mountSettingsView(host, { mode: 'settings', saveBar: false, fields });
    // The waiting list is the operator's, and the client reads the release list only on Agentic: it shows while Agentic is the choice and the server sent releases (never through the Hub)
    const group = host.querySelector('#update-channel[role=radiogroup]');
    if (!group) return;
    const sync = () => {
        const slot = host.querySelector('.update-waiting-slot'); slot?.replaceChildren();
        const agentic = !!host.querySelector('#uc-agentic')?.checked;
        const auto = host.querySelector('.update-channel-auto'); if (auto) auto.hidden = !agentic;
        if (agentic && s.waiting.length && slot) slot.append(waitingBlock(s));
    };
    group.addEventListener('change', sync); sync();
}

/** Save what the pane changed, with Apply: "Check for updates automatically" and the update channel (each only when it changed; a no-op when the pane was not drawn). Returns true when something was saved. */
export async function applyUpdatePrefs() {
    const s = getUpdateStatus();
    if (isCloud() || !s) return false;
    let saved = false;
    const auto = document.getElementById('settings-update-auto');
    if (auto && !auto.disabled && auto.checked !== (s.auto !== false)) { await savePrefs({ auto: auto.checked }, { auto: s.auto }); saved = true; }
    const picked = document.querySelector('input[name="update-channel"]:checked');
    const channelChanged = !!(s.hasChannel && picked && picked.value !== s.channel);
    if (channelChanged) { await saveChannel(picked.value); saved = true; }
    if (saved) await refreshUpdateStatus();
    if (channelChanged && body()) { await showUpdatesPane(); if (picked.value === 'agentic') redrawWhenFactsArrive(0); } // the pane shows the new channel's facts now (#5561)
    return saved;
}

// The server answers the first status after a switch to Agentic from a cold cache: the channel only, its release list a moment later. Read it again a few times, and redraw while nothing is pending in the pane.
const RETRY_MS = [2000, 5000, 12000];
function redrawWhenFactsArrive(i) {
    if (i >= RETRY_MS.length) return;
    setTimeout(async () => {
        const cur = getUpdateStatus();
        if (!body() || !cur || cur.channel !== 'agentic' || cur.approved) return; // the pane is gone, the choice changed, or the facts are here
        await refreshUpdateStatus();
        const picked = document.querySelector('input[name="update-channel"]:checked');
        if (body() && picked && picked.value === 'agentic') await showUpdatesPane();
        redrawWhenFactsArrive(i + 1);
    }, RETRY_MS[i]);
}
