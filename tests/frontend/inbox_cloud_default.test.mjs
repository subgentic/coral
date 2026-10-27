// Without the Hub's boot value the cloud dashboard is as it was (Goal #100, #9542): the same checks with the switch off.
import { run } from './helpers/inbox_cloud_checks.mjs';
await run(false);
