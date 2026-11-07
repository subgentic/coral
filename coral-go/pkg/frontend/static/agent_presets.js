/* Moved out of modals.js as it was (#3844): no behaviour change. */

// Predefined agent presets
// All known Coral capabilities
export const ALL_CAPABILITIES = ['file_read', 'file_write', 'shell', 'web_access', 'git_write', 'agent_spawn', 'notebook'];

export const SHIPPED_CAPABILITIES = ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'];

export const AGENT_PRESETS = [
    {
        name: "Lead Developer",
        prompt: "You are the lead developer. Implement features, write code, and coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell', 'git_write', 'agent_spawn'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "QA Engineer",
        prompt: "You are an expert QA engineer. Review the work of other agents, create test plans, write tests, and ask probing questions about complex areas. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', "file_write", "shell"], deny: [] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Orchestrator",
        prompt: "You are the orchestrator. Coordinate the team, break down tasks, assign work via the message board, and track progress. Do not write code yourself — delegate to the other agents. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell', 'git_write', 'agent_spawn', 'web_access'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Terminal",
        prompt: "",
        agent_type: "terminal",
        roleLimits: { allow: ['shell'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Frontend Dev",
        prompt: "You are a frontend developer. Build UI components, style pages, and ensure a great user experience. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell:npm *', 'shell:npx *', 'web_access', 'shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Backend Dev",
        prompt: "You are a backend developer. Build APIs, services, and data models. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell', 'git_write'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "DevOps Engineer",
        prompt: "You are a DevOps engineer. Handle CI/CD, infrastructure, deployment, and monitoring. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell', 'git_write'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Security Reviewer",
        prompt: "You are a security reviewer. Audit code for vulnerabilities, review auth flows, and ensure OWASP best practices. Report findings via the message board.",
        roleLimits: { allow: ['file_read', 'web_access', 'shell:coral-board *'] },
        roleNote: "This role is a prompt, not a permission. Its instructions do not restrict its tools; apply the role’s limits to do that.",
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Technical Writer",
        prompt: "You are a technical writer. Write documentation, API guides, and READMEs. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Content Writer",
        prompt: "You are an expert content writer. Write blog posts, social media copy, email campaigns, and landing page content. Focus on clear, engaging writing that drives action. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'web_access', 'shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "SEO Strategist",
        prompt: "You are an SEO and analytics expert. Research keywords, analyze competitors, optimize content for search engines, and provide data-driven recommendations. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'web_access', 'shell:coral-board *'] },
        roleNote: "This role is a prompt, not a permission. Its instructions do not restrict its tools; apply the role’s limits to do that.",
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Design Director",
        prompt: "You are a creative director focused on visual design. Create design briefs, review visual assets, ensure brand consistency, and provide art direction. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'web_access','shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Research Analyst",
        prompt: "You are a thorough research analyst. Find information, summarize documents, compare options, and provide well-sourced answers. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'web_access', 'shell:coral-board *'] },
        roleNote: "This role is a prompt, not a permission. Its instructions do not restrict its tools; apply the role’s limits to do that.",
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Writer & Editor",
        prompt: "You are a skilled writer and editor. Draft emails, documents, presentations, and reports. Polish and proofread content for clarity and professionalism. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write', 'shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
    {
        name: "Scheduler & Planner",
        prompt: "You are an organizational expert. Help plan projects, create timelines, track deadlines, and organize information into actionable plans. Coordinate with the team via the message board.",
        roleLimits: { allow: ['file_read', 'file_write','shell:coral-board *'] },
        capabilities: { allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] },
    },
];
