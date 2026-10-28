## Positional extraction options

**Rule:** Place tar's destination option before every member selector: `tar -xzf archive -C destination --wildcards 'prefix/*'`. Never assume a trailing `-C` relocates earlier positional selectors.

**Why:** GNU tar treats these options positionally. A review extraction with member patterns before `-C` wrote source into the working directory instead of the intended temporary checkout.

**How to apply:** Assert the destination is new or explicitly owned, place `-C` before patterns, and check extracted files exist under that destination before reading or testing them. Keep a pre-extraction manifest for any workspace path that could collide. If an extraction escapes, preserve the generated artifacts separately and restore affected existing files only from independently hash-verified pre-extraction bytes.

