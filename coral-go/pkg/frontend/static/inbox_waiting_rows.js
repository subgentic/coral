/* The three renderers of a Waiting on an agent row for an answered ask or a sent comment (#19904): what the row opens, says and does. Lazy (the start path stays net zero); the sidebar passes the few helpers it keeps to itself. */
import { importOnce } from './import_once.js';
import { go } from './nav.js';
import { keyRoute } from './routes.js';
import { boardTeamKey, LOCAL_SERVER } from './server_base.js';
import { markHidden } from './visible_marks.js';
import { isPhoneLayout } from './phone_layout.js';
const WA = await importOnce('./inbox_waiting_agent.js');
const AW = await importOnce('./inbox_agent_wait.js');
const DT = await importOnce('./data_table.js');
const { agentLink } = await importOnce('./agent_link.js');
const markTitle = t => markHidden(t, { strict: true });

export function make(env) {
    function openWaitItem(s) {
        const it = s.waitItem, team = boardTeamKey(LOCAL_SERVER, it.board || '');
        if (it.artifact?.hex) { importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(it.artifact.hex, { server: LOCAL_SERVER, board: it.board, filename: it.artifact.name })).catch(() => {}); return; }
        if (it.goal?.id) { go({ ...env.folderRoute, id: team, item: String(it.goal.id) }); return; }
        if (it.task?.id) { env.openItemRoute('tasks', team, String(it.task.id), `${team}#${it.task.id}`); return; }
        go(keyRoute('team', team));
    }
    function waitItemCell(s) {
        const it = s.waitItem, who = WA.whoOf(it), title = markTitle(WA.titleOf(it));
        const name = DT.primaryButton(title, `Open ${title}`); name.classList.add('inbox-review-name'); name.setAttribute('aria-label', `Open ${title}, ${WA.KIND_WORD[it.kind]}, waiting on ${who}`);
        const wrap = DT.el('span', 'inbox-review-item inbox-agent-first'), sender = agentLink(who.trim() || 'sender unknown', { board: boardTeamKey(LOCAL_SERVER, it.board || ''), cls: 'inbox-review-from' });
        const pills = WA.pills(it, { openGoal: (team, id) => go({ ...env.folderRoute, id: team, item: String(id) }), openTask: (team, id) => env.openItemRoute('tasks', team, String(id), `${team}#${id}`) });
        const state = AW.stateNodes(s.agentRef, it.kind, isPhoneLayout()), chipNode = isPhoneLayout() ? null : AW.stateChip(s.agentRef), line = [WA.chip(it, who), ...state, WA.quote(it)];
        const note = it.kind === 'answered_ask' ? DT.el('span', 'inbox-extra-meta', 'No reply or task update yet') : null; // the mock's line after the agent's state (walk #20067)
        if (isPhoneLayout()) { wrap.append(sender, name); if (pills.childNodes.length) wrap.append(pills); wrap.append(DT.el('span', 'sr-only', `Waiting on ${who}, waiting on agent, not counted`), ...line); return wrap; }
        const meta = DT.el('span', 'inbox-meta'); meta.append(line[0], AW.waitTarget(sender), ...(chipNode ? [chipNode] : []), ...(note ? [note] : []), ...(pills.childNodes.length ? [pills] : []));
        wrap.append(name, line[line.length - 1], meta, ...line.slice(1, -1)); return wrap;
    }
    function waitItemActions(s) {
        const it = s.waitItem, ws = AW.agentWaitState(s.agentRef), title = markHidden(WA.titleOf(it), { strict: true }), team = boardTeamKey(LOCAL_SERVER, it.board || ''), box = DT.el('div', 'inbox-review-actions inbox-slots'), menu = [];
        const quiet = (text, slot, run) => { const b = DT.el('button', 'btn btn-quiet btn-small', text); b.type = 'button'; b.setAttribute('data-slot', slot); b.setAttribute('aria-label', `${text}: ${title}`); b.addEventListener('click', run); return b; };
        const thing = it.kind === 'comment_sent' ? 'thread' : ''; // the mock: an answered ask has Open agent and Nudge, a sent comment Open thread (a file's, or the goal's when there is no file); the goal and the task are the chips on the line (walk #20067)
        const agent = ws.live ? agentLink(ws.who, { board: team, session: ws.live.session_id, cls: 'btn btn-quiet btn-small inbox-open-agent', text: 'Open agent', label: `Open ${markHidden(ws.who, { strict: true })}` }) : null;
        const nudge = ws.state === 'awake' ? quiet('Nudge', 'nudge', () => AW.nudge(it, ws)) : null; nudge?.classList.add('inbox-nudge'); nudge?.setAttribute('aria-label', `Nudge ${markHidden(ws.who || 'the agent', { strict: true })}: ${title}`); // the mock draws Nudge as a button beside Open agent, not only in More (walk #20067 row 15)
        box.append(...[AW.wakeButton(ws, it.kind), thing ? quiet(`Open ${thing}`, 'open-file', () => openWaitItem(s)) : null, agent, nudge].filter(Boolean));
        menu.push(...AW.menuItems(it, ws, { openBoard: () => go(keyRoute('team', team)) }).filter(m => !/^Nudge /.test(m.label)), { label: 'View on board', title: 'Open the team’s board', run: () => go(keyRoute('team', team)) }, { label: 'Stop waiting', title: 'Take it off this list; nobody is told', run: () => { WA.dismiss(it); env.redraw(); } });
        const more = env.moreMenu(menu, title); more.setAttribute('data-slot', 'dots'); box.append(more); return box;
    }
    return { openWaitItem, waitItemCell, waitItemActions };
}
