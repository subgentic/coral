/* Review-pool words and area input shared by the agent settings and task surfaces. */
export const reviewAreas = text => [...new Set(String(text || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean))];
export function reviewAreasError(text) {
    const areas = reviewAreas(text);
    if (areas.length > 8) return 'Use at most 8 areas.';
    return areas.some(a => !/^[a-z][a-z0-9-]{0,23}$/.test(a)) ? 'Use area names of 1–24 letters, digits or hyphens, starting with a letter.' : '';
}
export const needsReview = task => task.status === 'review_pending';
export function reviewPoolInfo(task) {
    const w = task.workflow || task;
    const rounds = Array.isArray(w.review_rounds) ? w.review_rounds : [];
    const latest = rounds.at(-1);
    const reviewers = [...new Set((latest?.reviewers || task.reviewers || []).map(r => typeof r === 'string' ? r : r.reviewer).filter(Boolean))];
    const areas = Array.isArray(w.review_areas) ? w.review_areas : [];
    const pooled = w.review_in_pool === true;
    if (!pooled && !reviewers.length && !areas.length) return null; // older servers keep their existing review wording
    const wanted = Number(w.reviewers_wanted) || 1;
    return { areas, text: [pooled ? `In the pool${wanted > 1 ? ` · ${reviewers.length} of ${wanted} reviewers assigned` : ''}` : '', reviewers.length ? `Reviewer${reviewers.length > 1 ? 's' : ''}: ${reviewers.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Awaiting review' };
}
