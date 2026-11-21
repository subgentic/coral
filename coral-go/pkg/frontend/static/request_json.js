import { importOnce } from './import_once.js';
/** Request a same-origin JSON route and return its answer, or throw. The error is the server's own reason ({"error": "..."}) or "HTTP <status>", with .status and .data
 *  on it, so a caller that treats one status specially (a 409) reads e.status. A body, when there is one, is sent as JSON; an empty answer is {}. Unlike sendJson it throws
 *  for a refusal, and unlike apiFetch it names the status the way the settings dialogs always did. */
export async function requestJson(method, url, body) {
    return (await importOnce('./json_requests.js')).requestJson(method, url, body);
}
