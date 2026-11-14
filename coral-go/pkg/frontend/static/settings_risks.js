/* Loaded only with Settings. A warning remains beside every risky saved choice. */
import { importOnce } from './import_once.js';
const { showConfirmModal } = await importOnce('./confirm_dialog.js');
const { openSettingsGroup } = await importOnce('./settings_nav.js');
const choices = [
    { id: 'settings-permission-mode', value: 'bypassPermissions', label: 'Bypass permissions', text: 'Claude’s permission checks are off. Claude can run tools without asking.' },
    { id: 'settings-permission-mode', value: 'dontAsk', label: "Don't ask", text: 'Claude’s permission questions are off. Tools that need permission are denied instead of asking.' },
    { id: 'settings-remote-access-enabled', label: 'Remote access', text: 'Access is no longer limited to this computer. Other devices can control agents and read files after signing in.' },
    { id: 'settings-cloud-hub-operator', label: 'Let Coral Hub act as the Operator', text: 'Operator decisions are no longer limited to this computer. Coral Hub users with permission can make them here.' },
    { id: 'sec-hub-enabled', label: 'Let Coral Hub sign in here', text: 'Local sign-in is no longer required. Your linked Coral Hub account can sign in with full control.' },
    { id: 'settings-debug-input-log', label: 'Record what Coral types', text: 'Typed input is no longer kept out of the debug log. Passwords and other secrets may be recorded.' },
];
const get = e => e.type === 'checkbox' ? e.checked : e.value;
const put = (e,v) => { if (e.type === 'checkbox') e.checked = v; else e.value = v; };
const active = (c,v) => c.value ? v === c.value : v === true;
function text(e,t) { if (e.textContent !== t) e.textContent = t; }
export function wireSettingsRisks(modal) {
    if (modal.dataset.risks) { modal.dispatchEvent(new Event('coral-refresh-risks')); return; }
    modal.dataset.risks = '1';
    const previous = new WeakMap(), accepted = new WeakSet(), pending = new WeakSet();
    const summary = document.createElement('div'); summary.id = 'settings-safety-summary'; summary.className = 'settings-safety-summary'; summary.setAttribute('aria-live','polite');
    const security = document.getElementById('settings-pane-security');
    const heading = security?.querySelector('.settings-pane-title');
    const headingRow = heading?.closest('.agent-copy-hrow') || heading;
    if (headingRow) headingRow.after(summary); else security?.prepend(summary);
    function refresh() {
        const enabled = [];
        for (const id of new Set(choices.map(c=>c.id))) {
            const e = document.getElementById(id); if (!e) continue;
            if (!pending.has(e)) previous.set(e,get(e));
            const c = choices.find(c=>c.id===id && active(c,get(e)));
            const row = e.closest('.sv-row,.settings-cloud-switch-row,.sec-switch'); if (!row) continue;
            let note = row.querySelector('.settings-risk-warning');
            if (!note) { note = document.createElement('p'); note.className='settings-risk-warning'; note.id=`${id}-risk`; (row.querySelector('.sv-text') || row).append(note); const desc=e.getAttribute('aria-describedby'); e.setAttribute('aria-describedby',[desc,note.id].filter(Boolean).join(' ')); }
            note.hidden = !c; text(note,c ? `⚠ ${c.text}` : '');
            if(c) enabled.push(c);
        }
        const signature = enabled.map(c=>c.label).join('|');
        if(summary.dataset.signature!==signature) {
            summary.dataset.signature=signature; summary.replaceChildren();
            const list=document.createElement(enabled.length ? 'details' : 'div');summary.append(list);
            const title=document.createElement(enabled.length ? 'summary' : 'p'); title.textContent=enabled.length ? `Safety checks turned off: ${enabled.length}` : 'All safety checks are on'; list.append(title);
            for(const c of enabled) {
                const link=document.createElement('button'); link.type='button'; link.className='btn btn-small'; link.textContent=c.label;
                link.addEventListener('click',()=>{const e=document.getElementById(c.id),pane=e?.closest('.settings-pane');if(!e||!pane)return;openSettingsGroup(pane.dataset.group || pane.dataset.section);for(const fold of [e.closest('details')])if(fold)fold.open=true;const target=e._segmented?.querySelector('[aria-checked="true"]') || e;target.focus();target.scrollIntoView({block:'nearest'});}); list.append(link);
            }
        }
        const wake=document.getElementById('tb-autowake-on'),row=wake?.closest('.sv-row');
        if(row) { let note=row.querySelector('.settings-wake-warning'); if(!note){note=document.createElement('p');note.className='settings-risk-warning settings-wake-warning';note.textContent='⚠ Wakes with saved permissions, including bypass.';row.append(note);}note.hidden=!wake.checked;const hint=row.querySelector('.sv-help-text');if(hint)hint.hidden=wake.checked; }
    }
    modal.addEventListener('change',event=>{
        const e=event.target;if(e.dataset.saving==='1')return;if(accepted.has(e)){accepted.delete(e);return;}
        const want=get(e),c=choices.find(c=>c.id===e.id&&active(c,want));
        if(!c||want===previous.get(e))return;
        event.stopImmediatePropagation();event.preventDefault();
        const before=previous.has(e)?previous.get(e):(e.type==='checkbox'?false:'');
        pending.add(e);put(e,before);
        showConfirmModal(`Turn on ${c.label}?`,c.text,()=>{
            e.focus();put(e,want);pending.delete(e);accepted.add(e);e.dispatchEvent(new Event('change',{bubbles:true}));refresh();
        },()=>{pending.delete(e);put(e,before);refresh();e.focus();},{label:'Turn on',danger:false});
    },true);
    modal.addEventListener('focusin',event=>{if(choices.some(c=>c.id===event.target.id)&&!pending.has(event.target))previous.set(event.target,get(event.target));});
    modal.addEventListener('coral-refresh-risks',refresh);
    new MutationObserver(refresh).observe(modal,{subtree:true,childList:true,attributes:true,attributeFilter:['checked','disabled','data-shown','data-saved']});
    modal.addEventListener('change',refresh); refresh();
}
