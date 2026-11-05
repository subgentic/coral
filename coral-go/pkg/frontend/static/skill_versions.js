// The Operator's table groups versions; records remain separate for approval and pinned agent attachments.
export const skillFamily = r => JSON.stringify([r.name, r.publisher_kind || '', r.publisher_agent || '', r.publisher_team || '']);
export function skillVersions(records, skill) {
    return records.filter(r => skillFamily(r) === skillFamily(skill)).sort((a, b) => Number(b.version) - Number(a.version));
}
export function latestSkillRows(records, status = '') {
    const groups = new Map();
    for (const r of records) { const key = skillFamily(r); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
    const rows = [];
    for (const versions of groups.values()) {
        versions.sort((a, b) => Number(b.version) - Number(a.version));
        const row = status ? versions.find(r => r.status === status) : versions.find(r => r.status === 'approved') || versions[0];
        if (!row) continue;
        rows.push({ ...row, pendingVersion: versions.find(r => r.status === 'pending') || null });
    }
    return rows;
}
