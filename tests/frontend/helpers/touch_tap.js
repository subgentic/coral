// A touch tap and a touch scroll that headless Chrome on Linux (the CI runner) drives: Input.dispatchTouchEvent (touchStart / touchMove / touchEnd), the way the artifact viewer suites do.
// Input.synthesizeTapGesture and Input.synthesizeScrollGesture need a gesture pipeline that headless Linux Chrome does not run, so a tap made with them never reaches the page there (the phone-width suites of #14617, #14653 and others timed out on Linux while passing on a Mac).
'use strict';

/** Tap at a point {x, y}: one finger down and up. */
async function touchTap(client, point) {
    const p = { x: point.x, y: point.y };
    await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [p] });
    await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
}

/** Drag a finger from {x, y} by yDistance pixels (negative = the finger goes up, the page scrolls down), in a few small moves, then lift. */
async function touchScroll(client, { x, y, yDistance, steps = 8 }) {
    await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) await client.Input.dispatchTouchEvent({ type: 'touchMove', touchPoints: [{ x, y: y + (yDistance * i) / steps }] });
    await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
}

module.exports = { touchTap, touchScroll };
