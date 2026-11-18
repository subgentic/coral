/* Read a Hub refusal only when a caller has a failed reply to classify. */
export async function refusedTooLarge(resp) {
    if (!resp || resp.status !== 502 || !/json/i.test(resp.headers.get('Content-Type') || '')) return false;
    try { return (await resp.clone().json()).code === 'hub_reply_too_large'; } catch { return false; }
}
