# Ownership approval scope

## Read-only display contract

Command Center → System → Ownership displays structured immutable registry
scope in both the challenge card and its confirmation dialog. The server
compares the submitted artifact hash with the registered hash and independently
hashes the registered canonical UTF-8 artifact bytes. Only matching bytes,
structured title/purpose/scope/exclusions, and recorded authenticated registry
creator/source-thread provenance produce the verified display.

An ordinary missing record differs from a real bootstrap reservation without
a registered definition. Missing metadata/provenance, artifact mismatch,
registry unavailability and invalid registry bytes are explicit nonverified
states. Legacy publisher claims are not authenticated authorship. Imported
Replit provenance remains declared/unverified even when the registry registrar
is authenticated. No local artifact parsing or generated text fills gaps.

The enrichment preserves challenge and receipt lifecycle states, actor,
artifact, key and context bindings. Registry lookups are request-deduplicated
and bounded to four concurrent reads. These reads never initialize a registry,
register a task, write an approval, or grant ownership. Approval/rejection/
revocation behavior and founder-only server authorization are unchanged.

## Separate context boundary

Task scope verification is not promotion-candidate verification. The existing
challenge response contains a context digest but no decoded descriptor.
The UI labels this fact explicitly. A task's starting commit is not a candidate
approval. A future decoded-descriptor storage/transport/verification contract
requires separate scope; it cannot be inferred from a matching task hash.

## Verification and limits

Focused synthetic projection, lifecycle-preservation, bounded-lookup and
rendered-markup tests plus existing founder route-authentication tests:
27 passed, zero failures/skips. Typecheck passed. The application restarted
and its public landing page rendered. System-health checks passed.
The build launcher timed out, but its child completed frontend/server bundling
and the final historical-attribution release check, as recorded in the build
log. Signed-in founder interaction was not exercised: implementation stayed
in the assigned main window with no testing or implementation subagent.

The focused suites are registered beside ownership-client checks in the
canonical CI runner. An unsupported listing flag started that runner and was
interrupted early; no full-CI pass is claimed. Live founder decisions were
not run. Alden subsequently reviewed exact updated source and approved it
unconditionally. No registry mutation, shared migration, release, source promotion,
enrollment or observation was performed by this feature.

The live registry read disproved the stale claim that the registry is wholly
unavailable: authenticated list/bootstrap reads returned 200. The assigned
UI task itself returned TASK_NOT_FOUND; that remains a truthful missing-record
case, not permission to manufacture a registration.
