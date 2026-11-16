// Loaded only by the Inbox Getting started launch actions. The guides ship as starter skills.
import { importOnce } from './import_once.js';
const { AGENT_PRESETS } = await importOnce('./agent_presets.js');
export const GETTING_STARTED_PROMPTS = {
    "agent": AGENT_PRESETS.find(p => p.name === 'Getting started').prompt,
    "team": "Use the getting-started-team skill to guide me through working with a Coral team, one step at a time."
};
