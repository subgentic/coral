/* The words of the Info dialog's Skills and Memory rows (#13209, goal #218): pure functions from the routes' answers (loaded-skills, memory, memory/{id}) to lines of text, so a skill's name or a file's text is only ever put in the page as text. */
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line per loaded skill: "name v2, loaded 3 times", plus ", removed" or ", newer version approved"; [] when the answer is not a list (the row stays hidden), one line saying none when nothing was loaded. */
export function skillLines(result) {
    if (!result || !Array.isArray(result.skills)) return [];
    if (!result.skills.length) return ['None loaded yet'];
    return result.skills.map(s => `${String(s.name)} v${Number(s.version) || 0}, loaded ${plural(Number(s.loads) || 0, 'time')}${s.status === 'removed' ? ', removed' : s.newer_version ? ', newer version approved' : ''}`);
}

/** One item per memory or instruction file: {id, label: "CLAUDE.md: instructions, project"}; a file with a problem has no id (it cannot be opened) and says it. [] when there is no list; one id-less item saying none when there are none. */
export function memoryItems(result) {
    if (!result || !Array.isArray(result.files)) return [];
    if (!result.files.length) return [{ id: '', label: 'None found' }];
    return result.files.map(f => {
        const label = `${String(f.file)}: ${String(f.kind)}, ${String(f.level)}`;
        return f.problem ? { id: '', label: `${label} (${String(f.problem)})` } : { id: String(f.id), label };
    });
}

/** What the pre shows for one opened file: its text, with a line when it was cut, a line instead when it is binary or could not be read, a line when it is gone. */
export function memoryText(result) {
    if (!result) return 'This file could not be read.';
    if (result.problem) return `This file cannot be shown (${String(result.problem)}).`;
    if (result.binary) return 'This file is not text.';
    return `${String(result.text ?? '')}${result.truncated ? '\n\n[cut: the file is longer than is shown]' : ''}`;
}
