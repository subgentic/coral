// Sign-out destination is needed only when the person signs out.
import { isCloud } from './server_base.js';
import { returnAddress } from './served_address.js';
export function signoutAddress(loc) {
    const cloud = isCloud(), back = returnAddress(loc, { hash: !cloud });
    const safe = back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') && !/[\u0000-\u001f\u007f]/.test(back) ? back : '/agents';
    return (cloud ? '/signin?next=' : '/auth?return_to=') + encodeURIComponent(safe);
}
