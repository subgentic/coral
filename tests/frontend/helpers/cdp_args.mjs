// The arguments run_cdp_suites.mjs reads (#18145). It only ever read --only, so `node run_cdp_suites.mjs <suite>` ignored the bare name and started EVERY suite, holding a machine for an hour. An
// argument that is not one of these (or the value of one that takes a value) is refused with exit 2 before anything starts. Keep this list in step with the flag()/arg()/intArg() calls in the runner
// (cdp_args.test.mjs reads the runner and fails when they differ).
export const FLAGS = ['--allow-flaky', '--fail-on-leak', '--isolate', '--keep', '--no-restore', '--no-strict', '--no-tmux', '--prod-tier', '--sequences', '--strict', '--stress', '--tmux'];
export const VALUE_FLAGS = ['--chrome', '--cpu-throttle', '--only', '--part', '--results-out', '--retries', '--retry-max-secs', '--runs', '--shards', '--shuffle', '--timeout'];

/** What is wrong with `argv` (the arguments after the script's name), as lines to print; [] when it is all known. */
export function badArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) out.push(`${a} needs a value`);
      else i++; // its value is not an argument of its own
    } else if (!FLAGS.includes(a)) {
      out.push(a.startsWith('--') ? `unknown flag ${a}` : `unexpected argument "${a}": did you mean --only ${a}?`);
    }
  }
  return out;
}
