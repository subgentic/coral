import { importOnce } from './import_once.js';
import { isCloud } from './server_base.js';
/** True when this browser is the computer's own operator. Not in the cloud (it has no owner-only routes) and not when the auth status says a proxied or other-user browser is looking: those get 403 other_user on the owner-only routes (#21543). */
export const operatorHere = async () => !isCloud() && (await (await importOnce('./auth_status_read.js')).readAuthStatus())?.local !== false;
