/* Install the skill menu only when a word starts with $, leaving its dialog/routes off the startup graph. */
import { importOnce } from './import_once.js';
import { findTriggerStart } from './mention_list.js';
import { showToast } from './utils.js';
export function initSkillMention() {
    const input = document.getElementById('command-input');
    if (!input) return;
    let pending = false, dismissed = null;
    const escape = e => { if (e.key === 'Escape' && pending) dismissed = input.value.slice(0, input.selectionStart); };
    const trigger = () => {
        if (pending || findTriggerStart(input.value.slice(0, input.selectionStart), '$') < 0) return;
        pending = true; dismissed = null;
        importOnce('./skill_mention.js').then(m => {
            input.removeEventListener('input', trigger); input.removeEventListener('keydown', escape, true);
            const cancelled = dismissed !== null && dismissed === input.value.slice(0, input.selectionStart);
            m.initSkillMention({ dismissed: cancelled });
            if (!cancelled) m.refreshSkillMention(input);
        }).catch(() => { showToast('Skills could not be loaded. Type $ again to retry.'); }).finally(() => { pending = false; });
    };
    input.addEventListener('input', trigger); input.addEventListener('keydown', escape, true);
}
