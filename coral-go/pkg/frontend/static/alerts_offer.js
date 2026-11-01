/* The first agent a person starts is the moment desktop alerts make sense (#10068, desktop pass #10063): they are about to look at another tab while it works. Once per browser, when the browser has not been asked
 * yet and has not blocked alerts, a banner offers them with one button; its x is "not now". The banner is a strip in the page's flow under the top bar (as the sign-in banner is), so it pushes the page down and never covers a page's own
 * controls (#10248: a toast over the top of the page hid the Inbox's folder picker); its sentence wraps, it is not cut. The permission box is asked only from that click (a browser ignores one that is not). The switch in Settings >
 * Notifications is always there afterwards. */
import { browserLocal } from './safe_storage.js';
import { showToast, announceNotice } from './notifications.js';
import { desktopNotifySupported, desktopNotifyEnabled, desktopNotifyBlocked, enableDesktopNotify } from './desktop_notify.js';

export const ALERTS_OFFERED_KEY = 'coral-alerts-offered';
export const ALERTS_REOFFERED_KEY = 'coral-alerts-reoffered'; // the one second offer (#11893): never a third
export const REOFFER_AFTER_MS = 5 * 60 * 1000;

/** Offer desktop alerts after an agent started. Does nothing when this browser has no alerts, already has them, blocks them, or was already asked. */
export function offerAlertsAfterLaunch() {
    if (!desktopNotifySupported() || desktopNotifyEnabled() || desktopNotifyBlocked()) return false;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return false;
    try { if (browserLocal.get(ALERTS_OFFERED_KEY) === '1') return false; } catch { return false; }
    try { browserLocal.set(ALERTS_OFFERED_KEY, '1'); } catch { /* storage blocked: offered again next time, harmless */ }
    showOfferBanner();
    return true;
}

/** The offer once more, after the person dismissed it and the first thing that needs them has waited 5 minutes (#11893, Beta #11837: two questions waited 14 and 29 minutes with alerts off). `oldestMs` is when the oldest waiting item
 * began to wait. Only for a browser that was offered, dismissed, and could still turn alerts on; only while the tab is on screen (a banner in a hidden tab is not seen and would spend the one offer); never more than once. */
export function offerAlertsAgain(oldestMs, now = Date.now()) {
    if (!Number.isFinite(oldestMs) || now - oldestMs < REOFFER_AFTER_MS || document.hidden) return false;
    if (!desktopNotifySupported() || desktopNotifyEnabled() || desktopNotifyBlocked()) return false;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return false;
    try {
        if (browserLocal.get(ALERTS_OFFERED_KEY) !== '1' || browserLocal.get(ALERTS_REOFFERED_KEY) === '1') return false;
        browserLocal.set(ALERTS_REOFFERED_KEY, '1');
    } catch { return false; }
    showOfferBanner();
    return true;
}

const OFFER = 'Get an alert when an agent needs you or finishes a reply while you are in another tab?';

/** The offer as a strip in the page's flow, after the sign-in banner and before the views: it takes its own height, so nothing under it is covered. Gone for good on either button. */
function showOfferBanner() {
    document.getElementById('alerts-offer-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'alerts-offer-banner'; banner.className = 'notice notice-info notice-bar alerts-offer-banner'; banner.setAttribute('role', 'status');
    const text = document.createElement('div'); text.className = 'alerts-offer-text'; text.textContent = OFFER;
    const on = document.createElement('button'); on.type = 'button'; on.className = 'btn btn-small'; on.textContent = 'Turn on alerts';
    const off = document.createElement('button'); off.type = 'button'; off.className = 'btn btn-quiet btn-icon btn-small'; off.setAttribute('aria-label', 'Not now'); off.title = 'Not now'; off.textContent = '\u00d7';
    off.addEventListener('click', () => banner.remove());
    on.addEventListener('click', async () => {
        banner.remove();
        const granted = await enableDesktopNotify();
        showToast(granted ? 'Alerts are on. Change them in Settings > Notifications.' : 'Alerts stay off: your browser did not allow them. You can try again in Settings > Notifications.');
    });
    banner.append(text, on, off);
    const after = document.getElementById('local-auth-banner') || document.querySelector('header.top-bar');
    if (after) after.after(banner); else document.body.prepend(banner);
    announceNotice(OFFER); // a strip drawn with its words is not reliably read out: the notices' own live region says the sentence once
}
