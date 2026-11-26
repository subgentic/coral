/* The header's usage spot for an agent that has no usage yet: hidden, except for a pi agent. Its CLI gives Coral no usage (its own footer has it), so the spot says so in a short plain line instead of
 * staying blank (#21615). Lazy: the start path carries none of these words. */
import { state } from './state.js';

export function noUsage(el) {
    const pi = state.currentSession?.agent_type === 'pi';
    el.textContent = pi ? 'pi reports no usage to Coral' : '';
    el.style.display = pi ? '' : 'none'; // display-ok: the same element's other writers (token_usage_ui.js) set style.display, so this one must agree
}
