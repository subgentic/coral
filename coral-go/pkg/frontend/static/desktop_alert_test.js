/* "Send a test alert" in Settings > Notifications (walk 53, #17169): the person who turned Desktop alerts on sees one now, in the browser's own style, so they know what it looks like and that it works. Read only when the button is pressed. */
import { alertPrefs, desktopNotifyEnabled } from './desktop_notify.js';

/** Raise one test alert. Returns true when the browser took it; false when alerts are off, not allowed, or not supported. */
export function sendTestAlert() {
    if (typeof Notification === 'undefined' || !desktopNotifyEnabled() || Notification.permission !== 'granted') return false;
    try {
        const n = new Notification('Coral', { body: 'This is a test alert. Coral will look like this when an agent needs you.', tag: 'coral-test-alert', silent: !alertPrefs().sound });
        n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
        return true;
    } catch { return false; }
}
