// #8372: pin drag/paste and per-session upload ownership before moving them out of controls.js.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
try {
    const { state } = await importUi('state');
    const controls = await importUi('controls');
    const a = { session_id: 'image-a', name: 'a', type: 'live', agent_type: 'claude', server: 'local' };
    const b = { ...a, session_id: 'image-b', name: 'b' };
    state.currentSession = a;
    const calls = [], pending = [], revoked = [];
    let preview = 0;
    URL.createObjectURL = () => `blob:fixture-${++preview}`;
    URL.revokeObjectURL = url => revoked.push(url);
    globalThis.fetch = window.fetch = async (url, opts = {}) => {
        if (String(url).endsWith('/api/upload')) {
            calls.push({ sid: opts.body.get('session_id'), filename: opts.body.get('file').name });
            return new Promise(resolve => pending.push(() => resolve(new Response(JSON.stringify({ path: '/uploads/fixture.png', filename: 'fixture.png' }), { status: 200 }))));
        }
        return new Response('{}', { status: 200 });
    };
    const image = name => new File(['image'], name, { type: 'image/png' });
    const pane = document.getElementById('command-pane');
    const input = document.getElementById('command-input');
    controls.initImageDrop();
    const event = (type, props) => { const e = new Event(type, { bubbles: true, cancelable: true }); for (const [k,v] of Object.entries(props)) Object.defineProperty(e,k,{value:v}); return e; };
    const dropped = image('drop.png');
    const transfer = { types: ['Files'], items: [{kind:'file',type:'image/png'}], files: [dropped, new File(['text'], 'ignore.txt', {type:'text/plain'})] };
    pane.dispatchEvent(event('dragenter', {dataTransfer:transfer}));
    assert.equal(document.getElementById('drop-overlay').style.display, 'flex');
    pane.dispatchEvent(event('drop', {dataTransfer:transfer}));
    assert.equal(document.getElementById('drop-overlay').style.display, 'none');
    assert.deepEqual(calls, [{sid:'image-a',filename:'drop.png'}], 'drop filters non-images and uploads to its selected agent');
    state.currentSession = b;
    controls.renderAttachments();
    pending.shift()();
    // Drain the actual upload via its observable status event, without a polling timer.
    const settled = () => new Promise((resolve, reject) => {
        const status=document.getElementById('image-attach-status');
        const observer=new MutationObserver(() => {clearTimeout(timer);observer.disconnect();resolve();});
        const timer=setTimeout(() => {observer.disconnect();reject(new Error('upload status did not settle'));},2000);
        observer.observe(status,{childList:true,subtree:true,characterData:true});
    });
    await settled();
    assert.equal(controls.getPendingAttachments(a).length,1);
    assert.equal(controls.getPendingAttachments(b).length,0,'finishing an old upload never attaches to the new agent');
    assert.equal(document.querySelectorAll('#image-attachments .image-attachment').length,0,'old completion does not draw on the new agent');

    let reads=0;
    const clipboard={items:[{type:'image/png',getAsFile(){reads++;return image('paste.png');}}]};
    const other=document.createElement('input');document.body.append(other);
    other.dispatchEvent(event('paste',{clipboardData:clipboard}));
    assert.equal(reads,0,'other text fields retain their paste');
    const paste=event('paste',{clipboardData:clipboard});
    input.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented,true);
    assert.equal(reads,1,'clipboard files are captured synchronously');
    assert.deepEqual(calls[1],{sid:'image-b',filename:'paste.png'});
    const done=settled();pending.shift()();await done;
    assert.equal(controls.getPendingAttachments(b).length,1);
    assert.equal(document.querySelectorAll('#image-attachments .image-attachment').length,1);
    controls.removeAttachment(0,b);
    assert.deepEqual(revoked,['blob:fixture-2'],'removing a chip releases its own preview');
    assert.equal(controls.getPendingAttachments(a).length,1,'removing from one agent retains the other agent attachment');
    assert.equal(controls.getPendingAttachments(b).length,0);
    console.log('image_composer: drag/paste filtering, synchronous clipboard capture, cross-session upload isolation, and preview cleanup pass');
} finally {
    dom.window.close();
}
process.exit(0); // controls imports the live UI graph, whose background timers are unrelated to these event contracts.
