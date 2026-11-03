/** True when the field still holds the folder this module suggested: only then is create_dir sent. */
export function usesSuggestion(input) {
    return !!(input && input.dataset.suggested && input.value.trim() === input.dataset.suggested);
}

