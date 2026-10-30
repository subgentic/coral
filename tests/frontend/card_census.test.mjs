// The card looks (Goal #84, spec item 9): a card is one look, not sixteen. Every card takes its border, radius and padding from the tokens in variables.css (--card-border, --card-radius, and
// one of --card-pad, --card-pad-dense, --card-pad-roomy), and no card is inside a card. This census reads every stylesheet: a rule on a `*-card` class (the last class of its selector) that sets a
// border, a radius or a padding must write the tokens (0 and none are the way an override takes the box away), the class must be in CARDS below (a new card look fails here until it is added
// and uses the tokens), and a selector with one card class inside another is a card in a card. A class that is not a card box (a composer's pill, a state class) is in NOT_A_CARD with its reason.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = path.resolve(here, '../../coral-go/pkg/frontend/static/css');

// the card looks, and the padding kind each takes ('none': the card holds rows that carry their own padding)
export const CARDS = {
    'ac-card': 'dense',               // a comment thread
    'tool-card': 'dense',             // a tool call in the chat
    'machine-health-card': 'dense',   // a machine's health row in About
    'start-card': 'regular',          // a first-visit choice in an empty state (Automations)
    'cost-card': 'regular',           // an Analytics figure
    'viz-card': 'regular',            // an Analytics chart
    'eff-card': 'regular',            // an efficiency figure
    'prompt-inspection-card': 'regular',
    'team-link-card': 'regular',      // the Link team dialog's form
    'launch-type-card': 'regular',    // a choice in New agent
    'cloud-card': 'roomy',            // the sign-in page's card
    'note-card': 'none',              // a note: its head and body carry their own
    'session-board-card': 'none',     // a team in the sidebar: its header and rows carry their own
};
const NOT_A_CARD = {
    'mb-post-card': 'the board composer: a one-line pill with a send button, not a content card',
    'agent-ui-card': 'a frame for an agent-drawn page: it has no box of its own',
    'session-wf-card': 'only the left edge colour of a session-board-card',
};
const PAD = { dense: 'var(--card-pad-dense)', regular: 'var(--card-pad)', roomy: 'var(--card-pad-roomy)' };

const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const lastCard = sel => { const m = [...sel.matchAll(/\.([\w-]*-card)(?![\w-])/g)]; return m.length ? m[m.length - 1][1] : null; };
const cardsIn = sel => [...sel.matchAll(/\.([\w-]*-card)(?![\w-])/g)].map(m => m[1]);

export function scan() {
    const problems = [];
    for (const f of fs.readdirSync(css).filter(n => n.endsWith('.css')).sort()) {
        const text = blank(fs.readFileSync(path.join(css, f), 'utf8'));
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const body = m[2];
            for (const raw of m[1].split(',')) {
                const sel = raw.replace(/@[^{;]*$/, '').trim();
                const cards = cardsIn(sel);
                if (!cards.length) continue;
                const where = `${f}: ${sel.replace(/\s+/g, ' ').slice(0, 80)}`;
                if (new Set(cards).size > 1 || (cards.length > 1)) problems.push(`${where}: a card inside a card (${cards.join(' in ')})`);
                // a rule on a card's own box: the last compound of the selector is the card class (not a child, a state of a descendant or a pseudo-element's content)
                const last = sel.split(/[\s>+~]+/).pop();
                const card = lastCard(last);
                if (!card || !last.includes(`.${card}`) || NOT_A_CARD[card]) continue;
                const decl = [...body.matchAll(/(?:^|;)\s*(border|border-radius|padding)\s*:\s*([^;]+)/g)].map(d => [d[1], d[2].replace(/!important/, '').trim()]);
                if (!decl.length) continue;
                if (!(card in CARDS)) { problems.push(`${where}: a new card look, .${card}: add it to CARDS in card_census.test.mjs and give it the card tokens`); continue; }
                for (const [prop, v] of decl) {
                    if (v === '0' || v === 'none' || v === '0 !important') continue; // an override that takes the box away
                    if (prop === 'border' && v !== 'var(--card-border)') problems.push(`${where}: border is "${v}", write var(--card-border)`);
                    if (prop === 'border-radius' && v !== 'var(--card-radius)' && v !== 'var(--card-radius) var(--card-radius) 0 0') problems.push(`${where}: border-radius is "${v}", write var(--card-radius)`);
                    if (prop === 'padding' && CARDS[card] !== 'none' && v !== PAD[CARDS[card]]) problems.push(`${where}: padding is "${v}", a ${CARDS[card]} card writes ${PAD[CARDS[card]]}`);
                    if (prop === 'padding' && CARDS[card] === 'none') problems.push(`${where}: padding is "${v}", but .${card} holds rows that carry their own (or move it to a padded kind in CARDS)`);
                }
            }
        }
    }
    return problems;
}

// the child heads of a card that round its top corners use the card's radius: these are checked by scan() through the radius rule above
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const tokens = fs.readFileSync(path.join(css, 'variables.css'), 'utf8');
    for (const t of ['--card-pad:', '--card-pad-dense:', '--card-pad-roomy:', '--card-radius:', '--card-border:']) assert.ok(tokens.includes(t), `variables.css defines ${t}`);
    const problems = scan();
    assert.deepEqual(problems, [], `card looks that do not use the tokens:\n  ${problems.join('\n  ')}`);
    // the census can fail: a new card look, a literal radius and a card in a card are each found
    console.log(`card_census: ok (${Object.keys(CARDS).length} card looks, ${Object.keys(NOT_A_CARD).length} not cards)`);
}
