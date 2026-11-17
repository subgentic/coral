// #17636 (walk 78): the "needs your answer" toast has an Open agent link and stayed 10 s: gone before a person looked up. It stays 30 s,.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { showNotificationToast } = await importUi('notifications');
const real = globalThis.setTimeout, delays = [];
globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return real(fn, 1e9, ...a); };
showNotificationToast('Lead', 'Which port?', () => {}, { silent: true });
globalThis.setTimeout = real;
const toast = document.querySelector('.notification-toast');
assert.ok(toast, 'the toast is drawn');
assert.ok(delays.includes(30000) && !delays.includes(10000), 'it leaves after 30 s, not 10: ' + JSON.stringify(delays));
console.log('notification_toast_time: ok'); process.exit(0); // the stubbed timers are not left to keep the process alive
