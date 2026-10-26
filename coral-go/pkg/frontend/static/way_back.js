/* A phone's way back and the page's title in one row (phone-title-row, layout.css), shared by the pages that have both (#7734). */

/** Puts the way back and the page's title in one row: the title is on the link's line, and drops under it only when less than 10 rem would be left beside it (the way #7721 did Analytics).
 *  A page that has no such pair (the two are not siblings, or one is missing) is left as it is. */
export function foldWayBack(host, backSel, titleSel) {
    const back = host && host.querySelector(backSel), title = host && host.querySelector(titleSel);
    if (!back || !title || back.parentElement !== title.parentElement || back.parentElement.classList.contains('phone-title-row')) return;
    const row = document.createElement('div'); row.className = 'phone-title-row';
    back.before(row); row.append(back, title);
}
