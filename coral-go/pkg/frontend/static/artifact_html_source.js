export function addToggle(body, opts) {
    const { content, filename, path, source, ctx, options, opened, render, scripts, isCloud } = opts;
    const wrapper = body.querySelector('.artifact-linked-preview');
    if (!wrapper) return;
    const bar = wrapper.querySelector('.artifact-scripts-bar') || wrapper.querySelector('.artifact-linked-notice');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-preview-mode-btn artifact-html-source-btn';
    btn.textContent = 'View source';
    btn.addEventListener('click', () => {
        ctx.renderContent(body, content, path, source.server);
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'back-link artifact-html-back';
        back.textContent = '← HTML preview';
        back.addEventListener('click', async () => {
            render(body, { content, name: filename, isStale: ctx.isStale });
            if (ctx.resetContent) ctx.resetContent();
            if (options.scripts && opened && !isCloud() && !ctx.isStale()) await scripts(body, { hex: opened[1], content, name: filename, server: source.server, board: options.board || '', ctx });
            if (!ctx.isStale()) addToggle(body, opts);
        });
        body.insertBefore(back, body.firstChild);
    });
    if (bar) bar.append(btn);
    else wrapper.insertBefore(btn, wrapper.firstChild);
}
