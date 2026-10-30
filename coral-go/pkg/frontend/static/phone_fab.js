/* The phone's + (#11236 approved, #11239 slice A): a top-level list page creates what it lists with ONE + at the bottom right, the same place on every page. Its menu follows the page: the Agents page's New agent and New team, Automations'
 * New job, New workflow and Build with an agent (the buttons the toolbar draws on a wide screen are not drawn on a phone). The page says which kind in phone_screens.js (`fab`); view_switch.js calls this on every view change. */
const KINDS = {
    agents: [['New agent', 'phone-fab-new', 'agent'], ['New team', 'phone-fab-new', 'team']],
    automations: [['New job', 'job-new', ''], ['New workflow', 'wf-create', ''], ['Build a workflow with an agent', 'wf-build-agent', '']],
};

/** Show the + for `kind` (a key of KINDS) or none; the menu above it is rebuilt only when the kind changes. */
export function syncPhoneFab(kind) {
    if (kind && KINDS[kind]) document.body.setAttribute('data-phone-fab', kind); else document.body.removeAttribute('data-phone-fab');
    const menu = document.getElementById('phone-fab-menu');
    if (!menu || !kind || !KINDS[kind] || menu.dataset.kind === kind) return;
    menu.dataset.kind = kind;
    menu.replaceChildren(...KINDS[kind].map(([label, action, arg]) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item overflow-menu-item'; b.setAttribute('role', 'menuitem'); b.setAttribute('data-on-click', action); if (arg) b.setAttribute('data-arg', arg); b.textContent = label;
        return b;
    }));
}
