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


## A grep pipeline does not establish read-only execution

Output filtering does not make a command read-only. A supported group selector
does not establish that another inspection-looking flag is supported.

**Why:** Combining an unsupported listing flag with a real CI group selector
started the group. Piping stdout through grep hid most execution output but did
not prevent child processes or their side effects. A later successful shell
command could also hide the runner's nonzero exit status.

**How to apply:** Verify every argument against the dispatcher before execution,
not just the command or group name. Until a listing/dry-run contract is proven,
inspect source or structured data without invoking the runner. Preserve child
failure status explicitly; do not use a grep pipeline as a safety boundary.

