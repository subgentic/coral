/* What each item of a sidebar menu does and what it keeps or loses (#15466, the Operator's ask), written from the server code: Sleep, Wake, ResetTeam, KillTeam and the Delete team dialog. Lazy, loaded with the menu's keys (kebab_keys.js).
 * Every item gets its line as a description a screen reader reads on focus (aria-describedby). A mouse or the keyboard shows the line of the item under it in a footer of the menu; a touch screen or a phone shows every item's line under its
 * label, since neither hovers (css/menu_help.css). Restart and Wake say what #15465 says, word for word. */
import { loadStyles } from './lazy_styles.js';

await loadStyles('menu_help.css'); // before any line is drawn: a line without its sheet would show as plain text

export const HELP = {
    'Add Agent': 'Adds another agent to this team. The agents already running are not touched.',
    'Sleep Team': "Stops every agent's terminal and pauses the board. Chats, files, tasks and goals stay; Wake Team continues each conversation.",
    'Wake Team': 'Starts each sleeping agent again where its conversation left off, and un-pauses the board.',
    'Save as Template': "Saves this team's agents, instructions and settings as a template to launch again. Chats, messages and goals are not saved.",
    'More': "Shows the team's other actions.",
    'Reset Team': 'Stops each agent and starts it again from its first instructions in a new chat, so its context is cleared. Old chats stay in History; the board, tasks, goals and files are kept.',
    'Kill All': "Stops every agent in the team now. Chats stay in History; the board, tasks and goals are kept. A Hermes agent's conversation is deleted with it.",
    'Delete team': "Deletes the team for good: its messages, tasks, goals, members, reminders, settings and more; the dialog lists everything. Chats stay in History and files are not touched. Only when no agent is running.",
    'Restart, same settings': 'Starts a fresh conversation with the same settings; the instructions are sent again.',
    'Restart with changes': 'Starts a fresh conversation with the settings you choose; the instructions are sent again.',
    'Wake': 'Continues the conversation.',
    'Sleep': 'Stops the terminal. The chat and files stay; Wake continues the conversation.',
    'Kill session': 'Stops it now. Its chat stays in History.',
};
const LABELS = Object.keys(HELP).sort((a, b) => b.length - a.length); // longest first: "Wake Team" before "Wake"
const NO_HOVER = '(pointer: coarse), (max-width: 639px)'; // the same query as css/menu_help.css
const HINT = 'Point at an item to see what it does.';
let serial = 0;

/** The table's label for an item: the page writes labels in sentence case ("Sleep team") where the markup says "Sleep Team", so the match ignores case. */
export const labelOf = item => { const t = item.textContent.trim().replace(/\s+/g, ' ').toLowerCase(); return LABELS.find(l => { const k = l.toLowerCase(); return t === k || t.startsWith(k + ' ') || t.startsWith(k + '…'); }); };

/** Give every item of `menu` its line (once) and the menu its footer. */
export function describe(menu) {
    for (const item of menu.querySelectorAll('.overflow-menu-item:not([data-help])')) {
        const label = labelOf(item);
        item.dataset.help = label ? '1' : '0';
        if (!label) continue;
        const line = document.createElement('div');
        line.className = 'menu-help-text'; line.setAttribute('aria-hidden', 'true'); line.id = `menu-help-${++serial}`; line.textContent = HELP[label];
        item.after(line);
        item.setAttribute('aria-describedby', line.id);
    }
    if (!menu.querySelector('.menu-help-foot')) {
        const foot = document.createElement('div');
        foot.className = 'menu-help-foot'; foot.setAttribute('aria-hidden', 'true'); foot.textContent = HINT;
        menu.append(foot);
        const r = menu.getBoundingClientRect(); // the menu grew under its button: keep it on the screen
        if (r.height && r.bottom > innerHeight - 4) menu.style.top = Math.max(4, (parseFloat(menu.style.top) || 0) - (r.bottom - (innerHeight - 4))) + 'px';
    }
}

const showFor = e => {
    const menu = e.target.closest?.('.sidebar-kebab-menu');
    if (!menu) return;
    describe(menu);
    const item = e.target.closest('.overflow-menu-item'), foot = menu.querySelector('.menu-help-foot'), line = item && document.getElementById(item.getAttribute('aria-describedby') || '');
    if (foot && !matchMedia(NO_HOVER).matches) foot.textContent = line ? line.textContent : HINT;
};
document.addEventListener('mouseover', showFor);
document.addEventListener('focusin', showFor);
document.addEventListener('click', e => { // a tap on a menu's button: the lines are there when the menu is
    if (!e.target.closest?.('[data-on-click="kebab-toggle"]')) return;
    setTimeout(() => { for (const m of document.querySelectorAll('.sidebar-kebab-menu')) if (m.style.display !== 'none') describe(m); }, 0);
}, true);
for (const m of document.querySelectorAll('.sidebar-kebab-menu')) if (m.style.display !== 'none') describe(m); // opened before this loaded
