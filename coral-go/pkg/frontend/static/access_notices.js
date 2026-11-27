// Share the existing Needs-you access-card slot and count; both feeds are lazy.
import { importOnce } from './import_once.js';
import { state } from './state.js';
const grants = await importOnce('./relayed_grant_notices.js');
const devices = await importOnce('./device_key_notices.js');
export const rows = () => [...grants.rows(), ...devices.rows()];
export const card = n => n.deviceKey ? devices.card(n.deviceKey) : grants.card(n);
export const refresh = () => Promise.all([grants.refresh(), devices.refresh()]);
document.addEventListener('coral:grant-notices', () => { state.grantN = rows().length; });

state.grantN = rows().length;
