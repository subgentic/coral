// The server's HTTP API as the signed-in person: the cookie from the one-time sign-in link, and the headers a same-origin browser call carries.
export async function signIn(base, link) {
    const res = await fetch(link, { redirect: 'manual' });
    const cookies = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => c.startsWith('coral_session'));
    if (!cookies.length) throw new Error('the sign-in link gave no session cookie (is it already used?)');
    return cookies.join('; ');
}

export function client(base, cookie) {
    return async function api(method, path, body, expected = [200, 201, 202]) {
        const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(Number(process.env.SCREENS_API_TIMEOUT_MS) || 20000),
        });
        const text = await res.text();
        let value;
        try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
        if (!expected.includes(res.status)) throw new Error(`${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`);
        return value;
    };
}
