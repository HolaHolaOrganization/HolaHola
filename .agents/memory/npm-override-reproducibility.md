Use exact, reviewed versions for security overrides when preparing reproducible releases. Passing local checks against installed dependencies does not prove a fresh CI installation will work.

**Why:** Fresh CI rejected an existing semver-compatible locked patch after a floating override resolved to a newer patch. Refreshing the lock through the supported package tool also raised an unrelated direct dependency's declared lower bound.

**How to apply:** Refresh dependencies through the package tools, inspect both the manifest and lockfile, preserve unaffected declared ranges, and check clean-install consistency. Do not treat regenerated metadata or local build success as proof that remote CI passed.


## Portable package locks

Package-tool output must remain portable outside the development workspace. Keep the project's public-registry guard unchanged.

**Why:** The supported installer wrote internal package-firewall tarball URLs into the lockfile. A clean-install dry run accepted the dependency graph, but Linux CI rejected the private URLs before installation.

**How to apply:** Inspect newly resolved URLs after package-tool use. Where public npm URLs are required, use the official distribution URL and verify that the existing integrity hash matches the public registry. Check registry portability as well as install consistency before committing.


## Effective JSON settings versus raw diffs

---
name: Effective dependency configuration and raw diffs
description: Reproducibility review needs both parsed dependency settings and raw source comparisons.
---

Compare effective parsed dependency configuration as well as the raw Git diff.
Duplicate JSON keys can make an apparent override change semantically inactive:
the parser uses the last occurrence. Do not silently normalize inherited keys
as part of a narrowly scoped release.

**Why:** A live-to-destination diff appeared to change an override, while the
effective npm configuration was different because of an inherited repeated
key. Looking at only the diff or only the parsed object gave an incomplete view.

**How to apply:** Check duplicate-key structure and the effective resolver
settings before attributing dependency changes or interpreting lock consistency.
Keep unrelated manifest cleanup separately reviewed; a dry run still does not
prove an installed build.

