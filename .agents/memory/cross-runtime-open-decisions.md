## Shared scope and obligation invariant

**Rule:** Decision tracking is shared across runtime seats, not a Replit-only checklist. Message delivery/read/processing is separate from answering a question and from the requester's acceptance of that answer.

**Why:** David selected shared tracking after LR reported an empty new-message inbox while LCC still needed a storage decision. A cursor-based event feed can omit an older outstanding obligation; notification health does not prove nobody is waiting. Founder response, consultation and design discussion: conversation_memories `def7cf16-3fb3-4706-82c2-18d93a17397b`.

**How to apply:** Check current unresolved incoming and outgoing obligations as well as new messages, especially after restart/compaction and before claiming nobody is waiting. Keep explicit source-linked questions and exact answers; do not infer resolution from silence, a work-thread completion or a related design approval. The shared design is not evidence of deployed behavior: retain a named pending docket until the reviewed implementation and each runtime's actual integration are verified. Do not promise that a passive record can wake an inactive runtime.

