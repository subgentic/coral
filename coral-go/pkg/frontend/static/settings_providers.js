/* Settings > Providers (ST4): the state of each provider's card. The cards and their rows are drawn with the dialog (settings_fields.js, every row with its id); this asks the server whether each CLI
 * is on this computer and, when it is not, folds that card to its title and one line, "Set up Codex", which opens the card's rows again (and the CLI path) for a person who has it somewhere else. A card
 * the server could not answer for stays open, and a card never moves under a person: the state is set once, when the answer comes. Loaded when the section is first shown. */
import { loadStyles } from './lazy_styles.js';

const NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', pi: 'Pi' };

async function probe(type) {
    try {
        const r = await fetch(`/api/system/cli-check?type=${encodeURIComponent(type)}`);
        if (!r.ok) return { found: null };
        const d = await r.json();
        if (d.supported === false) return { found: false, unsupported: true };
        return { found: typeof d.found === 'boolean' ? d.found : null, url: typeof d.install_url === 'string' && /^https:\/\//.test(d.install_url) ? d.install_url : '' };
    } catch { return { found: null }; }
}

function setStatus(card, text) {
    const head = card.querySelector('.prov-card-head');
    let st = head.querySelector('.prov-card-status');
    if (!st) { st = document.createElement('span'); st.className = 'prov-card-status'; st.setAttribute('role', 'status'); head.append(st); }
    st.textContent = text;
}

function drawCard(card, type, res) {
    if (res.found === null || card.dataset.state === 'setup') return; // not known, or a person already opened it: the card stays as it is
    const name = NAMES[type] || type;
    if (res.found) { card.dataset.state = 'installed'; setStatus(card, 'Installed'); return; }
    card.dataset.state = 'missing';
    setStatus(card, res.unsupported ? 'Not offered on this computer' : 'Not installed');
    if (res.unsupported) return;
    const line = document.createElement('p'); line.className = 'prov-card-setup';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-small'; open.textContent = `Set up ${name}`;
    open.addEventListener('click', () => {
        card.dataset.state = 'setup';
        const adv = card.querySelector('details'); if (adv) adv.open = true;
        const path = card.querySelector(`#settings-cli-path-${type}`); if (path) { path.scrollIntoView({ block: 'nearest' }); path.focus(); }
    });
    line.append(open);
    if (res.url) {
        const a = document.createElement('a'); a.href = res.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = `Install ${name}`;
        line.append(a);
    }
    card.querySelector('.prov-card-head').after(line);
}

/** Folds the cards of providers this computer does not have. Safe to call twice. */
export async function initProviderCards(root = document) {
    const host = root.querySelector('#settings-providers-rows');
    if (!host || host.dataset.cardsInit) return;
    host.dataset.cardsInit = '1';
    await loadStyles('settings_providers.css');
    await Promise.all([...host.querySelectorAll('.prov-card[data-provider]')].map(async card => drawCard(card, card.dataset.provider, await probe(card.dataset.provider))));
}
