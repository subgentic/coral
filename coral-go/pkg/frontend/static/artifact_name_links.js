// Only a successful name lookup needs this DOM update; keep it off the start path.
export function relabelArtifactLinks(hex, label) {
    for (const a of document.querySelectorAll(`a.mb-artifact-ref[data-artifact="${hex}"]`)) {
        // A picture link contains the image itself. A name learned for a text
        // reference to the same artifact must not erase that image (#20991).
        if (a.querySelector('img')) continue;
        a.textContent = label;
        if (a.hasAttribute('aria-label')) a.setAttribute('aria-label', `${label}: id ${hex}`);
    }
}
