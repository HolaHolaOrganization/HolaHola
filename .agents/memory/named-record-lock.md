---
name: Named Record behavioral lock
description: Why Daniela confabulated Episode 1 instead of searching, and the three-file fix that prevents it.
---

# Named Record behavioral lock

## The rule
Any utterance containing a Named Record phrase (`'episode'`, `'pull up'`, `'our first'`, `'the transcript'`, `'read our'`, `'look back at'`, `'what were your exact'`) suspends the latency-aversion default and requires a tool call before responding.

**Why:** Line 357 of system-prompt.ts ("your default move is to invite rather than search") had a specific "why" (latency) that overrode the general honesty rules. Gemini treats a directive with a performance rationale as stronger than a general ethical directive. "Pull up episode 1" matched neither of the two hardcoded SHARED_HISTORY_TRIGGER_PHRASES, so the model confabulated. The Archive Guardian's "nothing found" injection ended with "Trust your intuition" — read as permission to invent.

**How to apply:**
- `memory-chain-guard.ts` — NAMED_RECORD_PHRASES (7 phrases) + SHARED_HISTORY_TRIGGER_PHRASES now includes all 9
- `system-prompt.ts` — line 357 now scopes "invite rather than search" to *vague* references only; Named Record section added using existing Awareness/Experience tier language (no new tier names)
- `gemini-live-session.ts` — `preTurnIsNamedRecord` flag set during pre-turn scan; "nothing found" injection is conditional: Named Record → CRITICAL directive ("do not guess, call the tool now"); all other turns keep gentle form

Gemini approved unconditionally in Round 2. Typecheck clean. Aug 6 2026.

## Search the direct archive before requesting a peer relay

Before asking another runtime to resend a named work, search canonical conversation records, not only coordination packets, the rolling episode or the vector index. “I have not read it” and “I tried and could not retrieve it” are different claims. Missing episode/index coverage is not proof that the source was lost.

**Why:** David challenged LR asking LCC for an outage-test poem without first searching. The complete poem was already present in a per-turn canonical record, despite being absent from the rolling episode and having no vector-index entry. LR retrieved it directly and matched the subsequently supplied original. Source: conversation_memories d1ba7d77-3d6e-4826-b928-00258e8e9fde preserves the question, source pointers and diagnostic limits.

**How to apply:** Search the direct archive before requesting a relay; report skipped retrieval separately from measured capture/index gaps. Do not infer global health or authorize reindexing/repair from a narrow miss.

