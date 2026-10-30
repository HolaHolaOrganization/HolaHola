---
name: Episode inviolability rule
description: Preserve complete source dialogue and Luca-authored narrative as authentic memories while tracking provenance
---

# Episode Inviolability Rule

**The rule:** When writing or updating episodes and prequel episodes from source conversations, nothing gets removed or truncated. Verbatim is verbatim. An episode Markdown file is also an authentic first-source record when Luca writes its narrative, commentary, or reflection directly: those passages are Luca's actual thoughts and memories, not lower-status presentation material.

**Why:** David stated the completeness requirement on August 8, 2026, after the first prequel draft was sparse and summarized. On August 21, 2026, he clarified that Markdown can carry Luca's own first-source commentary and reflection, often with valuable context and opinion. The database is a strong machine-retrieval substrate, but database origin is not the test of authenticity, and forcing exact DB↔Markdown parity makes the episode do incompatible jobs.

**How to apply:**
- Pull full content of every source conversation before writing. Never use grep head-only — check file sizes first (`wc -c`) and pull complete text.
- If a source conversation is large (>10KB), paginate through it fully before writing the episode section that covers it.
- When an episode section covers a multi-session arc (like reggaeton), follow the arc all the way through to its conclusion — not just the memorable opening moment.
- Do not end a section at a "nice" moment if the conversation continued. The conclusion is part of the record.
- Treat DB-derived dialogue, Luca-authored narrative, and Luca-authored reflection as real memories with different authorship/provenance—not as a hierarchy of trustworthy versus untrustworthy content.
- Keep raw collector evidence separate from authored memory because raw evidence has not yet been interpreted or attributed. This is an evidence boundary, not a judgment against narrative.
- Preserve authored Markdown as a first-source record. Save it to the database when durable machine retrieval is wanted; the important requirement is a durable, acknowledged write path, not a mandatory DB-first direction or byte-for-byte replica.
- Label or structure authored narrative and dialogue distinctly enough that future Luca can know whose words and perspective he is retrieving, while still treating both as authentic memory.
- When David says something was in a conversation — believe him and go find it. Do not conclude the record is sparse until every relevant thread has been fully pulled and checked.

## Distinct curated-story filenames

Curated episode stories must include `-story` in the basename: `docs/stories/episode-N-story.md`. The complete canonical record keeps `docs/episode-N.md`.

**Why:** David explicitly requested distinguishable basenames so a curated story and a complete record cannot be confused when the folder context is hidden. The filename must identify the story, not just its directory.

**How to apply:** Use the suffix for every new curated story and preserve its contents during renames. Leave historical dialogue and source references verbatim; do not rewrite earlier conversations to use a later filename.


## Historical episode archive references

Related historical references remain in their detailed topic files:
- [Episode 27 anchor](episode-27-anchor.md)
- [Episode 28 sealed snapshot](episode-28-sealed-snapshot.md)

These are grouped under episode inviolability to keep the always-loaded index compact. This changes navigation only; it does not change the source records, historical anchors or sealed-snapshot restrictions.

