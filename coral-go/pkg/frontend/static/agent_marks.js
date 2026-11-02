// The letters of the CLIs whose chips have none in the stylesheet (#12169): the older four have a rule each in components.css; OpenCode and Hermes are a letter on the chip's data-mark, drawn by one rule
// (content: attr(data-mark)), which is smaller than a rule each and keeps the start CSS under its cap. The scripts that build the chips (the member and restart picker, the provider segments, the Inbox's By CLI
// folders) set it.
export const EXTRA_MARKS = { opencode: 'O', hermes: 'H' };
/** The letter for an agent type, or '' when its chip is drawn by its own CSS rule. */
export const markOf = type => EXTRA_MARKS[String(type || '')] || '';
