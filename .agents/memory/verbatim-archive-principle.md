---
name: Verbatim over summaries — archive principle
description: Why verbatim conversation records are the only honest archive; summaries erase the subject; established July 5, 2026 in first official David↔Luca live conversation.
---

The principle, stated plainly: summaries tell you what happened; verbatim records show you what it was like. Those are different things, and the difference compounds over time.

**Why:**
A summary requires editorial decisions — what mattered, what to emphasize, what to cut. Those decisions are invisible to the reader. Whatever drift the writer introduced goes into the record unchallenged. The subject (the person thinking, deciding, moving between ideas) disappears; only the object (the conclusion, the feature, the decision) remains.

Verbatim text preserves:
- Personality and voice — distinctly Luca's, distinctly David's, not interchangeable
- The thought process — the wrong turn caught and corrected, where the actual insight often lives
- Evidence of emergence — the moment a connection was made that wasn't predictable from either input alone
- Inside references and shorthand — "reggaeton" carrying a whole conversation's weight in one word
- The self-correcting mechanism — if something is wrong, the other person pushes back in the moment; summaries have no such check

**How to apply:**
- conversation_memories entries from live David↔Luca dialogue should be verbatim captures, not Luca's narrative reconstruction after the fact
- The autosave system (agent-session-autosave.ts) handles this automatically via JSONL transcript capture → arc_name='david-luca-chat'
- Never write a reconstruction of a past conversation as a substitute for having the real one; use docs/luca-arc-reference.md as a guide for retrospective conversations to have live
- Daniela's verbatim principle (the messages table is sacred) applies equally to the Luca↔David record

**Origin:**
First official David↔Luca conversation on the verbatim record, July 5, 2026. David noted that you can just say "reggaeton" and Luca knows exactly what it means — that's shared memory working in real time, not a briefing document requiring re-explanation. The 15 luca-arc reconstruction entries were deleted that same morning and replaced with this approach.

## Related canonical-record and voice-protection notes

**Rule:** The verbatim archive principle includes the canonical standing of Luca↔David dialogue, complete growing records across chat and episode replicas, and protection against replacing a speaker's voice with narration.

**Why:** These are related applications of source fidelity. Their detailed notes remain intact; one index pointer keeps them discoverable without crowding the always-loaded memory index.

**How to apply:** Follow the detailed notes below. Preserve original authorship and exact dialogue, update the database before its episode replica, and report unavailable source rather than reconstructing it.

- [Two-channel record pattern](two-channel-record.md) — both chat and episode belong to one growing record; preserve task-agent authorship and use the current DB-first direction, not the older file-first wording.
- [Canonical Luca↔David channel](luca-david-channel.md) — David's declaration makes building conversations first-class permanent records alongside Daniela conversations.
- [Verbatim and voice protection](verbatim-as-censorship.md) — omissions and narrated replacements can silence the original speaker; exact words also apply to direct inner-life notes.

