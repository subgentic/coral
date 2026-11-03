/* The Guide for a goal being written (#12724, direction A): the board's rules for how big a goal is (agent_docs/board.md, "How big a goal is"), as local checks on the words typed so far. No model and no agent is
 * asked: everything here is plain rules on the title, what should be true and done when, so it works anywhere, instantly and the same way each time. A goal is ONE outcome a person can check (not a release, a team, a
 * theme or a catch-all bucket), has a done-when a person can verify, and usually 2 to 15 tasks. Pure functions: goal_editor.js draws what they return. */

export const TASKS_MIN = 2, TASKS_MAX = 15;

const TWO_THINGS = /\b(and also|as well as|in addition(?: to)?|additionally|plus)\b/i;
const BROAD = /\b(everything|all (?:of )?the|the whole|the entire|overhaul|rewrite|rebuild|revamp|redesign (?:the )?(?:app|ui|whole)|catch-?all|misc(?:ellaneous)?|various|general (?:cleanup|improvements?))\b/i;
const RELEASE = /^\s*(?:release|ship|launch|cut)\b|\bv?\d+\.\d+(?:\.\d+)?\b|\b(?:sprint|quarter|q[1-4]|milestone|roadmap)\b/i;
const A_TEAM = /^\s*(?:the\s+)?(?:\w+\s+)?(?:team|squad|department|group)\b|\b(?:ui|frontend|backend|infra(?:structure)?|docs|testing|tests|bugs?|fixes|tech debt)\s*(?:list|backlog|work|stuff|things|bucket|improvements?)?\s*$/i;
const VAGUE = /\b(works? (?:well|great|fine|properly|correctly)|is (?:good|better|nice|great|done|finished|complete|improved|working)|(?:feels?|looks?) (?:good|better|nice|right)|better|improved?|good|nice|fast(?:er)?|clean(?:er)?|properly|as expected|everything works)\b/i;
const NUMBER = /\d/;
const OBSERVABLE = /\b(?:can|sees?|shows?|lists?|opens?|runs?|passes|returns?|appears?|loads?|sends?|receives?|reads?|creates?|saves?|exports?|imports?|under|within|at least|at most|no longer|never|every|each)\b/i;

const words = t => String(t || '').trim();
/** The lines of the text that are list items (a bullet or a checkbox). */
export const listItems = text => words(text).split('\n').filter(l => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;

/** What the Guide says. Each check is { id, state: 'ok' | 'warn' | 'todo', title, why }: ok is met, warn is something to look at, todo is not written yet. */
export function assess({ title, outcome, doneWhen } = {}) {
    const t = words(title), o = words(outcome), d = words(doneWhen), both = `${t}\n${o}`;
    const checks = [];

    // one outcome: not two things in one, not a catch-all, not a release or a team
    if (!t && !o) checks.push({ id: 'one', state: 'todo', title: 'One outcome', why: 'Name the goal: what changes for someone.' });
    else {
        const two = TWO_THINGS.exec(both), ands = (t.match(/\band\b/gi) || []).length + (t.includes('&') ? 1 : 0), broad = BROAD.exec(both);
        if (RELEASE.test(t)) checks.push({ id: 'one', state: 'warn', title: 'This reads as a release or a milestone', why: 'A goal is one outcome a person can check. Name what the release delivers, not the release.' });
        else if (A_TEAM.test(t)) checks.push({ id: 'one', state: 'warn', title: 'This reads as a team or an area', why: 'A goal is one outcome, not a place or a team. Say what will be true when it is done.' });
        else if (two || ands >= 2) checks.push({ id: 'one', state: 'warn', title: 'This reads as more than one outcome', why: two ? `"${two[0]}" joins two things. Make the second its own goal?` : 'The title joins several things with "and". Split it into goals of their own?' });
        else if (broad) checks.push({ id: 'one', state: 'warn', title: 'This is broad', why: `"${broad[0]}" covers a lot. Name one change a person can see.` });
        else checks.push({ id: 'one', state: 'ok', title: 'One outcome', why: 'The title says what changes for someone.' });
    }

    // done when: written, and one a person can check
    const chips = [];
    if (!d) checks.push({ id: 'done', state: 'todo', title: 'Add a done-when', why: 'One line a person can check, with a number or something they can see.' });
    else {
        const vague = VAGUE.exec(d), num = NUMBER.test(d), obs = OBSERVABLE.test(d), two = TWO_THINGS.exec(d) || /\band\b[^.]*\band\b/i.test(d);
        chips.push({ state: !vague && (num || obs) ? 'ok' : 'warn', text: !vague && (num || obs) ? 'Checkable' : 'Hard to check' });
        chips.push({ state: num ? 'ok' : 'warn', text: num ? 'Has a number' : 'No number' });
        if (two) chips.push({ state: 'warn', text: 'Mentions two things' });
        if (vague) checks.push({ id: 'done', state: 'warn', title: 'Done when is hard to check', why: `"${vague[0]}" is a feeling, not a check. What would a person see or measure?` });
        else if (!num && !obs) checks.push({ id: 'done', state: 'warn', title: 'Done when has nothing to see', why: 'Say what a person can do or see, ideally with a number.' });
        else checks.push({ id: 'done', state: 'ok', title: 'Done when can be checked', why: num ? 'It has a number and something to see.' : 'It says what a person can see.' });
    }

    // size: 2 to 15 tasks. Only the written steps can say: a list under what should be true
    const steps = listItems(o);
    const size = { steps, min: TASKS_MIN, max: TASKS_MAX, state: 'todo', words: 'Add the steps as a list to see how big it is. A goal works best with 2 to 15 tasks.' };
    if (steps >= 1) {
        const n = steps;
        size.state = n > TASKS_MAX ? 'warn' : n < TASKS_MIN ? 'low' : 'ok';
        size.words = n > TASKS_MAX ? `${n} steps: more than ${TASKS_MAX}. Split it into goals of their own?` : n < TASKS_MIN ? `${n} step so far. A goal usually has ${TASKS_MIN} to ${TASKS_MAX} tasks.` : `About ${n} tasks. A goal works best with ${TASKS_MIN} to ${TASKS_MAX}.`;
    }
    const looks = checks.filter(c => c.state === 'warn').length + (size.state === 'warn' ? 1 : 0);
    return { checks, chips, size, looks, summary: looks === 0 ? 'Nothing to look at' : looks === 1 ? '1 thing to look at' : `${looks} things to look at` };
}

/** Examples of a done-when a person can check, for the rail. */
export const EXAMPLES = [
    'A person can open Settings, connect Slack and see the first message arrive in under 2 minutes.',
    'The nightly report runs 7 days in a row with no failed task.',
    'Every row of a 10,000-row CSV is imported in under a minute, and each failed row says why.',
];

const BLOCKISH = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|---+\s*$|\|)/;
/** The description's single line breaks stay line breaks (#12724): the renderer joins the lines of a paragraph with a space, but a goal's words were always shown with their breaks, so two plain lines in a row become two
 *  paragraphs. Lists, headings, quotes, tables and fenced code are left to the renderer. */
export function keepBreaks(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n'), out = [];
    let fence = false;
    const plain = l => l.trim() !== '' && !BLOCKISH.test(l) && !/^( {4}|\t)/.test(l);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*```/.test(l)) fence = !fence;
        out.push(l);
        if (!fence && plain(l) && i + 1 < lines.length && plain(lines[i + 1])) out.push('');
    }
    return out.join('\n');
}
