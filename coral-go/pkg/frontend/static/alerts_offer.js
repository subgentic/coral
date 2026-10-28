/* The first agent a person starts is the moment desktop alerts make sense (#10068, desktop pass #10063): they are about to look at another tab while it works. Once per browser, when the browser has not been asked
 * yet and has not blocked alerts, a toast offers them with one button; its × is "not now". The permission box is asked only from that click (a browser ignores one that is not). The switch in Settings >
 * Notifications is always there afterwards. */
import { browserLocal } from './safe_storage.js';
import { showToast } from './notifications.js';
import { desktopNotifySupported, desktopNotifyEnabled, desktopNotifyBlocked, enableDesktopNotify } from './desktop_notify.js';

export const ALERTS_OFFERED_KEY = 'coral-alerts-offered';

/** Offer desktop alerts after an agent started. Does nothing when this browser has no alerts, already has them, blocks them, or was already asked. */
export function offerAlertsAfterLaunch() {
    if (!desktopNotifySupported() || desktopNotifyEnabled() || desktopNotifyBlocked()) return false;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return false;
    try { if (browserLocal.get(ALERTS_OFFERED_KEY) === '1') return false; } catch { return false; }
    try { browserLocal.set(ALERTS_OFFERED_KEY, '1'); } catch { /* storage blocked: offered again next time, harmless */ }
    showToast('Get an alert when an agent needs you or finishes a reply while you are in another tab?', false, undefined, {
        action: {
            label: 'Turn on alerts',
            onClick: async () => {
                const on = await enableDesktopNotify();
                showToast(on ? 'Alerts are on. Change them in Settings > Notifications.' : 'Alerts stay off: your browser did not allow them. You can try again in Settings > Notifications.');
            },
        },
    });
    return true;
}
