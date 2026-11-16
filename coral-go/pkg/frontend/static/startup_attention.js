// Bare returning starts only; explicit links never load this check (#16894).
import { liveListReady } from './initial_load.js';
import { isPhoneLayout } from './phone_layout.js';
import { isCloud } from './server_base.js';
import { parse } from './routes.js';
import { importOnce } from './import_once.js';
export async function startupRoute(lastPlace) {
    await liveListReady;
    let attention = 0;
    try { attention = await (await importOnce('./inbox_sidebar.js')).startupNeedsCount(); }
    catch { /* A failed attention read must still show the remembered destination. */ }
    const back = parse(lastPlace || '', '');
    const place = back && (back.view === 'team' || ((back.view === 'agents' || back.view === 'chats') && back.id));
    const restored = !attention && !isPhoneLayout() && !!place;
    const route = restored ? back : attention || !isPhoneLayout() ? { view: 'inbox-folder', folder: 'needs' } : { view: 'agents' };
    return { route, restored, keep: isCloud() && route.view === 'inbox-folder' };
}
