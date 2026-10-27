/* Which answers of a permission card are STANDING ones (a permanent or session-wide allow: "Yes, and don't ask again", "Allow for all future sessions", "Trust this folder"), for a phone's card, where they are
 * set apart from the bar's one-time answers (#9583, UI/UX's call on #9562). Pure: no DOM, no imports.
 *
 * It fails closed: a missed standing answer is the unsafe miss (a permanent allow one tap from Yes), a one-time answer set apart is only a reach. So an answer is one-time ONLY when it is plainly a denial
 * (No, Deny, Cancel, Reject ...: the label starts with one) or plainly a single yes (Yes, Allow, Proceed, Approve, OK, with at most "once", "just this once", "this time" after it, or "only" anywhere in a
 * yes); every other label of a permission card is standing, recognised or not. A key hint at the end ("(y)", "(esc)", "(shift+tab)") is not part of the words. */
const HINT = /\s*\((?:[a-z]|esc|enter|shift\+tab|ctrl\+[a-z]|tab)\)\s*$/i;
const DENIAL = /^\s*(no|deny|denied|cancel|reject|decline|skip|abort|stop|quit|exit|esc|escape)\b/i;
const YES = /^\s*(yes|allow|approve|accept|ok|okay|proceed|continue|run|go ahead|sure)\b/i;
const PLAIN_YES = /^\s*(yes|allow|approve|accept|ok|okay|proceed|continue|run|go ahead|sure)\b[\s,.:;!-]*(?:and\s+)?(?:(?:just\s+)?(?:this\s+time|once(?:\s+only)?)|proceed|run it|go ahead|continue)?[\s.!]*$/i;
const ONLY = /\b(only|just\s+this|once|one[\s-]time)\b/i;

const words = label => String(label == null ? '' : label).replace(HINT, '').trim();

/** Is this answer plainly one-time (a denial, or a single yes)? */
export function isOneTime(label) {
    const w = words(label);
    if (!w) return true; // nothing to judge by: not a thing to hide
    if (DENIAL.test(w)) return true;
    if (PLAIN_YES.test(w)) return true;
    return YES.test(w) && ONLY.test(w);
}

/** The standing answers among a permission card's select options ({label}): every one that is not plainly one-time. */
export function standingOptions(options) { return (options || []).filter(o => !isOneTime(o && o.label)); }
