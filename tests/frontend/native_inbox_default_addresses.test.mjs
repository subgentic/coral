// Goal #100 (#9549): without the boot value the Chats addresses are what they were (checks in helpers/old_addresses_checks.mjs).
import { run } from './helpers/old_addresses_checks.mjs';
await run(false);
