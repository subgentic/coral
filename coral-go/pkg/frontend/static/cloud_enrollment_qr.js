// The local enrollment image contains a bearer capability. Its lifetime follows
// the waiting code; neither its URL nor its accessible text contains that capability.
import { loadStyles } from './lazy_styles.js';
await loadStyles('enrollment_qr.css');

export function enrollmentQR(root) {
    let generation = 0, key = '', figure = null, expiry = null;
    const clear = () => {
        generation++;
        clearTimeout(expiry); expiry = null;
        if (figure) { const img = figure.querySelector('img'); if (img) { img.onload = null; img.onerror = null; img.removeAttribute('src'); } figure.remove(); }
        figure = null; key = '';
    };
    return {
        stop: clear,
        render(st) {
            const until = Math.min(Date.parse(st.expires_at), Date.parse(st.enroll_qr_expires_at)), code = root.querySelector('[data-cloud="code"]');
            if (!code || code.offsetParent === null || !root.isConnected || root.offsetParent === null || st.state !== 'enrolling' || !Number.isFinite(until) || until <= Date.now()) { clear(); return; }
            const next = `${st.user_code}|${st.verification_url}|${st.expires_at}|${st.enroll_qr_expires_at}`;
            if (key === next && figure) return;
            clear(); key = next;
            const own = generation;
            figure = document.createElement('figure'); figure.dataset.cloud = 'qr'; figure.className = 'enrollment-qr'; figure.hidden = true;
            const image = document.createElement('img'); image.width = 256; image.height = 256; image.alt = 'QR code to connect from your phone';
            const caption = document.createElement('figcaption'); caption.textContent = 'Scan with your phone to open Coral Hub. Check the code and computer key before approving.';
            const current = figure;
            image.onload = () => { if (own !== generation) return; if (current.isConnected && code.offsetParent !== null && root.offsetParent !== null && Date.now() < until) current.hidden = false; else clear(); };
            image.onerror = () => { if (own === generation) clear(); }; // link and code remain the fallback
            current.append(image, caption); code.append(current);
            image.src = `/api/cloud/enroll-qr?g=${own}`;
            expiry = setTimeout(() => { if (own === generation) clear(); }, Math.min(until - Date.now(), 2147483647));
        },
    };
}
