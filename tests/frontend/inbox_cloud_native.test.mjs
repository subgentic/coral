// Goal #100 slices 1 and 2 (#9542): the Hub-served dashboard with the boot value inbox:'native' (checks in helpers/inbox_cloud_checks.mjs).
import { run } from './helpers/inbox_cloud_checks.mjs';
await run(true);
