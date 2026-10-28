/* Whether an agent's menu offers Edit instructions (#10133): not for a terminal (it has no Behavior prompt), and not on a Hub-served dashboard, where the route is never reachable and saving would only show the Hub's refusal. */
export const instructionsOffered = (session, cloud) => !cloud && !!session && session.agent_type !== 'terminal';
