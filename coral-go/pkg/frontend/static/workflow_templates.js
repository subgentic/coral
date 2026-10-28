/* Workflow templates (#10277, Mobile #10267): "Start from a template" in New workflow fills the name, description and steps of an example, ready to change and create. The first is daily-motivation, the workflow Coral seeds on
 * a first run: a person who deleted it, or never opened it, can still start from it. A template is data; nothing is saved until Create workflow. */
export const WORKFLOW_TEMPLATES = [
    {
        id: 'daily-motivation',
        label: 'Daily motivation (example)',
        name: 'my-daily-motivation', // not the seeded workflow's own name, which a workflow may already hold
        description: 'Example: generates a motivational message and shows it as a popup',
        steps: [
            { name: 'generate-message', type: 'agent', prompt: 'Generate a single short, unique, and inspiring motivational message (2-3 sentences max). Output ONLY the message text, nothing else — no quotes, no labels, no explanation.' },
            { name: 'show-notification', type: 'shell', command: 'MSG=$(cat {{prev_stdout}}) && coral-agent notify --title "Daily Motivation" --message "$MSG" --level success --alert' },
        ],
    },
];

export const templateById = id => WORKFLOW_TEMPLATES.find(t => t.id === id) || null;
