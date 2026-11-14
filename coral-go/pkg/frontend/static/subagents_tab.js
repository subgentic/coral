/* The Sub-agents tab (#16016, the Operator's request): each sub-agent the selected agent launched, with what it was asked (the launch's description), its state and how long it ran. The tab is not in the page: this module adds its button and panel
 * only while the agent has sub-agents (so the start HTML, script and sheet carry none of it), and takes them away when the agent has none or another agent is chosen. Everything that came from the agent's files (a description, a
 * type, a model) is set as text. The rows are the list subagents.js already holds (state.currentSubagents); a row opens the same detail dialog the Tasks list's sub-agent rows open (their action). */
import { state } from './state.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
import { compactDuration, formatCost } from './format.js';
import { pollEvery } from './overload.js';
import { fitWords } from './dock_tabs.js';

const TAB = 'agentic-tab-subagents', PANEL = 'agentic-panel-subagents';
let _timer = null, _ro = null;

const STATE_CLASS = { Done: 'subagents-state-done', Running: 'subagents-state-running', Stopped: 'subagents-state-stopped' };
const stateWord = sa => (sa.status === 'completed' || sa.finished ? 'Done' : sa.status === 'in_progress' ? 'Running' : 'Stopped');

/** How long it ran: start to its last activity, or to now while it runs. A stopped one with no end shows no duration rather than one that keeps growing. */
function ranFor(sa) {
    const start = Date.parse(sa.started_at || sa.created_at || ''), running = stateWord(sa) === 'Running';
    const end = running ? Date.now() : Date.parse(sa.last_activity_at || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
    return compactDuration((end - start) / 1000);
}

function drawRows(panel, list) {
    const head = el('div', 'subagents-head', `${list.length} sub-agent${list.length === 1 ? '' : 's'} launched by this agent`);
    const rows = el('ul', 'subagents-list'); rows.setAttribute('aria-label', 'Sub-agents');
    for (const sa of list) {
        const word = stateWord(sa), li = el('li', 'subagents-row'), open = el('button', 'subagents-open');
        open.type = 'button'; open.dataset.subagentId = sa.subagent_id || ''; open.setAttribute('data-on-click', 'task-subagent-open'); // the Tasks list's own action opens the detail dialog
        const title = sa.description || (sa.subagent_type ? `${sa.subagent_type} sub-agent` : 'Sub-agent');
        const top = el('span', 'subagents-top');
        top.append(el('span', 'subagents-state ' + STATE_CLASS[word], word), el('span', 'subagents-title', title));
        const bits = [sa.subagent_type, ranFor(sa) && `ran ${ranFor(sa)}`, sa.api_calls ? `${sa.api_calls} call${sa.api_calls === 1 ? '' : 's'}` : '', sa.cost_usd > 0 ? formatCost(sa.cost_usd) : ''].filter(Boolean);
        open.append(top, el('span', 'subagents-meta', bits.join(' · ')));
        open.setAttribute('aria-label', `${word}: ${title}. ${bits.join(', ')}. Open`);
        li.append(open); rows.append(li);
    }
    panel.replaceChildren(head, rows);
}

function ensureTab() {
    let btn = document.getElementById(TAB), panel = document.getElementById(PANEL);
    if (btn && panel) return { btn, panel };
    const tasks = document.getElementById('agentic-tab-tasks'), tasksPanel = document.getElementById('agentic-panel-tasks');
    if (!tasks || !tasksPanel) return null;
    btn = el('button', 'tab agentic-tab'); btn.id = TAB; btn.type = 'button'; btn.title = 'Sub-agents: the agents this agent launched';
    btn.addEventListener('click', () => window.switchAgenticTab?.('subagents', 'top'));
    const icon = el('span', 'material-icons', 'account_tree'); icon.setAttribute('aria-hidden', 'true');
    const count = el('span', 'tab-count agentic-tab-count'); count.id = 'subagents-count';
    btn.append(icon, el('span', 'agentic-tab-word', 'Sub-agents'), count);
    tasks.after(btn);
    _ro = new ResizeObserver(fitWords); _ro.observe(btn); fitWords(); // the tab strip refits its words for the new tab (it is not in the strip at start)
    panel = el('div', 'agentic-panel'); panel.id = PANEL; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Sub-agents');
    tasksPanel.after(panel);
    return { btn, panel };
}

function removeTab() {
    clearInterval(_timer); _timer = null;
    _ro?.disconnect(); _ro = null; // the observer goes with the tab it watched (Security INFO, #16314)
    const btn = document.getElementById(TAB), panel = document.getElementById(PANEL);
    const wasOpen = !!btn?.classList.contains('active');
    btn?.remove(); panel?.remove();
    if (wasOpen) window.switchAgenticTab?.('tasks', 'top'); // the open tab went with the agent that had them
}

/** Called after the agent's sub-agents are read: adds, redraws or removes the tab. */
export async function syncSubagentsTab() {
    const list = Array.isArray(state.currentSubagents) ? state.currentSubagents : [];
    if (!list.length) { removeTab(); return; }
    await loadStyles('subagents_tab.css');
    const t = ensureTab();
    if (!t) return;
    const n = document.getElementById('subagents-count'); if (n) n.textContent = String(list.length);
    t.btn.setAttribute('aria-label', 'Sub-agents'); t.btn.title = `Sub-agents: ${list.length} launched by this agent`;
    drawRows(t.panel, list);
    clearInterval(_timer); // a running one's time keeps counting while the panel is open
    _timer = list.some(sa => stateWord(sa) === 'Running') ? pollEvery(() => { if (t.panel.isConnected && t.panel.classList.contains('active')) drawRows(t.panel, state.currentSubagents || []); }, 15000) : null;
}
