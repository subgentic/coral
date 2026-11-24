// #20967 v3: signing and one-time join secrets belong to the Hub's own UI.
// Served by a Hub (state.hub) the line names only the computer: the Hub has no page for this yet, those routes stay shut (#21088).
export const HUB_JOIN_GUIDANCE = "Allow new Hubs and manage keys on your Hub's page for this computer, or at the computer.";
export const HUB_JOIN_GUIDANCE_SERVED = 'Allow new Hubs and manage keys at the computer.';
export const joinGuidance = hub => hub ? HUB_JOIN_GUIDANCE_SERVED : HUB_JOIN_GUIDANCE;
