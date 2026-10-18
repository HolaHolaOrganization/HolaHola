---
name: Replit post-merge process holds
description: Why stopping workflows alone does not preserve a hold across platform task merges.
---

A stopped workflow is not a durable hold across a platform task merge. On 2026-10-16, the application, validation, and standalone capture watchdog were observed running after a completed verification boot had been stopped. Stopping the parent run-group as well as the application and validation children removed the remaining capture process. The exact restart trigger and any intervening writes were not established.

**Why:** The application role gate does not protect standalone writers launched outside the application entrypoint. Platform reconciliation can therefore defeat a process-only hold without defeating the application gate.

**How to apply:** After a task merge during a hold, independently check workflow state, standalone writer processes, and listeners. Stop the parent run-group where necessary. Durable prevention requires reviewed entrypoint or configuration controls for all shared-state writers; do not claim the hold survives future merges merely because the application gate passed. Preserve uncertainty about intervening effects and do not restart capture or incident recovery to investigate.


## Workflow listings can omit the parent run-group

The workflow inventory can omit a configured parent run-group even while that parent starts standalone tasks. Do not infer that a parent is absent merely because the workflow listing contains only its children.

**Why:** On 2026-10-17 the workflow API listed only the application and validation children. The tracked configuration still defined the Project parent with a standalone capture task, and explicitly stopping that parent succeeded despite its omission from the listing. Held writer processes had been observed running.

**How to apply:** During an active process hold, inspect both the workflow listing and the configured run-group, stop the verified parent as well as affected children, and independently inspect standalone processes afterward. Stopping processes does not make the hold durable when the active checkout still lacks reviewed launch guards.

