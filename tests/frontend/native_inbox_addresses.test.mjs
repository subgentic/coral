// Goal #100 (#9549): the Hub-served dashboard with the boot value inbox:'native': the old Chats and Board entry points lead to the Inbox (checks in helpers/old_addresses_checks.mjs).
import { run } from './helpers/old_addresses_checks.mjs';
await run(true);
