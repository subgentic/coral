/* Settings > Agents > Default models: each provider's box is a dropdown of the models the composer offers, with "The CLI's own default" first and "Other…" last, which shows the old text box for a model id that is not in the list
 * (Desktop tester's note, #10000: a blank box reads as "type something here"). The text box stays the one place the form reads: the dropdown only sets its value, so the code that fills and saves Settings is unchanged and a
 * saved id that is not in the list shows under Other, in the box. Idempotent: called after the dialog's values are filled and again when the model list arrives. */
import { modelName } from './model_labels.js';

const PROVIDERS = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi']];
const OTHER = '__other__';

const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });

function syncOne(provider, label) {
    const input = document.getElementById(`settings-default-model-${provider}`);
    if (!input) return;
    let sel = document.getElementById(`settings-model-pick-${provider}`);
    if (!sel) {
        sel = document.createElement('select');
        sel.id = `settings-model-pick-${provider}`; sel.className = 'settings-select settings-model-pick';
        sel.setAttribute('aria-label', `${label} default model`);
        input.before(sel);
        input.classList.add('settings-model-text');
        input.placeholder = 'Model id';
        input.setAttribute('aria-label', `${label} default model id`);
        sel.addEventListener('change', () => {
            if (sel.value === OTHER) { input.hidden = false; input.focus(); return; }
            input.value = sel.value; input.hidden = true;
            input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); // the form's own listeners (the Unsaved changes note) hear it as a typed value
        });
    }
    const ids = [...document.querySelectorAll(`#settings-models-${provider} option`)].map(o => o.value).filter(Boolean);
    const cur = input.value.trim();
    sel.replaceChildren(opt('', "The CLI's own default"), ...ids.map(id => opt(id, modelName(provider, id) || id)), opt(OTHER, 'Other…'));
    sel.value = cur === '' ? '' : ids.includes(cur) ? cur : OTHER;
    input.hidden = sel.value !== OTHER;
}

/** Draw (or redraw) the four dropdowns from the model lists and the boxes' values. */
export function syncModelPicks() { for (const [p, label] of PROVIDERS) syncOne(p, label); }
