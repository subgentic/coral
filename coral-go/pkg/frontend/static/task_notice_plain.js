import { state } from './state.js';
/** A task notice in plain words (#16853). Coral types "[Task #4 (high)] Title — assigned to you, run 'coral-board task claim 4' to start" into the agent: the chat showed that command line to the person, and the title in it was the one at delivery time, so a task edited since read differently from the Tasks tab.
 *  The pill says what happened; the title is the stored task's when this board's list has it (titleOf), the notice's own otherwise. Any other text is returned as it came. */
const TASK_NOTICE_RE = /^\[(New )?Task #(\d+)( \([a-z]+\)| reassigned to you| reassigned — now unassigned)?\]\s*([\s\S]*?)\s+—\s+(?:assigned to you, )?run 'coral-board task claim[^']*' to (?:start|pick it up)\.?$/i;
export function plainTaskNotice(text, titleOf = id => state.currentBoardTasks?.find(x => Number(x?.id) === id)?.title) {
    const m = TASK_NOTICE_RE.exec(String(text || '').trim());
    if (!m) return text;
    const [, isNew, id, how = '', sent] = m;
    const title = titleOf?.(Number(id)) || sent;
    const said = `${isNew ? 'New task' : 'Task'} #${id} ` + (isNew ? 'is open to claim' : /unassigned/.test(how) ? 'is open to claim again' : /reassigned/.test(how) ? 'was reassigned to you' : 'was assigned to you');
    return title ? `${said}: ${title}` : said;
}
