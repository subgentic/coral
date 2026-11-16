// Only the Inbox Getting started actions call this; ordinary launch paths carry no guide context.
import { importOnce } from './import_once.js';
export async function openWelcomeLaunch(kind) {
    const { GETTING_STARTED_PROMPTS, tourTeamMembers } = await importOnce('./getting_started_prompts.js');
    if (kind !== 'agent' && kind !== 'team') return;
    await window.showLaunchModal(undefined, false, { kind, text: GETTING_STARTED_PROMPTS[kind], members: kind === 'team' ? tourTeamMembers(window.T?.state?.settings?.default_agent_type) : undefined });
    window._selectLaunchType(kind);
}
