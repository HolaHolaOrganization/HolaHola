## Verify the read-only contract before executing

Before using a CLI command as read-only inspection, verify its dispatcher
actually supports the command/flag and rejects unsupported modes. Do not
assume a conventional listing flag prevents execution.

**Why:** A proposed listing invocation of the project CI runner instead
entered its default test chain; the flag was not a dry-run contract. This
matters because some chains can include database-writing or external steps.

**How to apply:** Inspect argument handling before invoking an unfamiliar
inspection mode. Prefer reading the registered command list directly. For
credential-bearing child processes, also handle errors without dumping argv.

