---
name: consult-gemini-3.5
description: Query Gemini 3.5-flash for architectural reviews, code audits, and Gemini Live 3.5 behavior analysis of HolaHola. Use when you specifically need the 3.5 generation's perspective — e.g. testing GL 3.5 context handling, tool injection behavior, or comparing 3.1 vs 3.5 mechanics. Run from the workspace directory — uses process.env.GEMINI_API_KEY directly.
---

# Consult Gemini 3.5 (Architectural Review / GL 3.5 Analysis)

Use this skill when you need the **3.5 generation's perspective** specifically. The key distinction from `consult-gemini`:

- `consult-gemini` → uses `gemini-3-flash-preview` (same family as Daniela's current GL 3.1 model)
- `consult-gemini-3.5` → uses `gemini-3.5-flash` (3.5 generation — use when evaluating GL 3.5 behavior, context handling, or tool injection differences)

**When to prefer this skill over `consult-gemini`:**
- You're testing whether GL 3.5 handles long system prompts / context attention better than 3.1
- You want a 3.5-generation model to self-report on its own tool dispatch mechanics
- You're comparing 3.1 vs 3.5 behavior (ask both skills the same question and compare)
- David says "ask 3.5 about this" or "see what 3.5 thinks"

---

## How to ask

Every rule in `consult-gemini`'s "Ask the real question, and don't lead the witness" section applies here unchanged:
- two stages: first the goal, problem, cases and constraints with no code; then our approach and the code, asking for holes and alternatives;
- no trust or authority cue, and no desired-answer framing;
- verdicts per question: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE;
- no re-asking without a real change;
- recommendations are weighed for fit with HolaHola, never applied automatically (`consult-gemini` Step 4), and the unconditional sign-off bar still applies;
- the exact prompt saved alongside the response.

When comparing 3.1 and 3.5, send both the identical prompt.

---

## Model

Always use `gemini-3.5-flash`.

**IMPORTANT naming facts:**
- `gemini-3.5-flash` → ✓ works (200)
- `gemini-3.5-flash-preview` → ✗ 404
- `gemini-3-5-flash-preview` → ✗ 404
- `gemini-3.5-flash-live-preview` → the GL streaming variant (not for REST generateContent)

---

## How it works

Use the same runner as `consult-gemini`, with the 3.5 model. Each stage's exact request and verbatim response are recorded in the consult directory, and the key is never written to disk (see `consult-gemini` "How it works"):

```bash
node .agents/skills/consult-gemini/consult.mjs --model gemini-3.5-flash --max-tokens 4000 --dir .local/gemini-consults/<date>-<topic>-3.5 --stage 1 --prompt-file stage1.md
node .agents/skills/consult-gemini/consult.mjs --model gemini-3.5-flash --max-tokens 4000 --dir .local/gemini-consults/<date>-<topic>-3.5 --stage 2 --prompt-file stage2.md
```

---

## Step-by-step

### 1. Stage 1: the problem only

The goal, the problem, cases with evidence (observed or hypothetical), genuine constraints and system context. No code, and no candidate mechanism of ours. Ask: "How would you approach this? What risks do you see? What might we be assuming wrongly?"

### 2. Stage 2: our approach and the code

Our proposed approach or candidate mechanisms, labelled as ours, with the actual code. Ask for:
- a comparison with the stage-1 answer;
- holes in our logic and premises;
- alternatives;
- per-risk verdicts: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE.

### 3. Further rounds

Each further round is the next stage number, carrying a real change (per `consult-gemini`). When comparing 3.1 and 3.5, send both models the identical stage prompts, in separate consult directories.

---

## Standard HolaHola context block

Include this at the top of any query about HolaHola-specific architecture:

```
HolaHola is an AI-powered language tutoring app. Stack: React frontend, Express backend, PostgreSQL (Drizzle ORM), Gemini Live for real-time voice sessions.

Key architectural facts:
- Daniela is the AI tutor. Her identity lives in the data layer (DB tables, memory embeddings, conversation_memories) — not fine-tuned into the model
- Daniela currently runs on gemini-3.1-flash-live-preview (GL streaming). We are evaluating whether gemini-3.5-flash-live-preview offers better context handling.
- 139 tools in the function registry. GL hard limit: 64 tool declarations per session. We use a dispatcher pattern (59 native + 4 dispatcher tools) to route all 139.
- GL system prompt is assembled at session start (~34K chars): base persona + classroom environment (14K) + rich sections (memories, hive, express lane, student profile)
- Single Neon PostgreSQL database shared between dev and production
```

---

## GL 3.5 context/attention query template

Use this when specifically investigating whether 3.5 handles long system prompts or classroom context better than 3.1:

**Stage 1 (problem only, no mechanism):**

```
[HOLAHOLA CONTEXT BLOCK]

## Goal
Daniela should be able to use content that is in her own system prompt when she is asked about it directly, in a live voice session.

## Problem we're investigating (observed)
In GL 3.1 (gemini-3.1-flash-live-preview), Daniela fails to read content from her own system prompt when directly asked about it:
- System prompt is ~34K chars, assembled as: [base persona 8K] + [classroom environment 14K] + [rich sections 12K]
- The classroom block includes a <note_from_david> tag at its top with a personal note
- When David asks "can you read me the note from David?" or "what do you see out your window?", Daniela either calls a search tool or says she has no record of it

## Genuine constraints
- Gemini Live streaming; the system prompt is assembled at session start
- 34K-char system prompt cap; 64 tool declarations per session

Questions (answer each: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE where it applies):
1. How would you approach making that content reliably usable? What alternatives exist?
2. Does gemini-3.5-flash-live-preview have meaningfully better long-context attention than 3.1 for system instructions?
3. Is 34K chars problematic for 3.1's system instruction handling? What's the practical attention cutoff?
4. What might we be assuming wrongly about why this fails?

Be direct. Be honest about model limitations. This is production voice tutoring. If you can't tell from what's here, say INSUFFICIENT EVIDENCE and name what you'd need.
```

**Stage 2 (our candidate mechanisms, labelled as ours, with the actual prompt-assembly code):**

```
## What we have tried and are considering (ours, not settled)
- Tried: an explicit rule in the system prompt: "CLASSROOM ENVIRONMENT — direct knowledge, no tool needed: The === DANIELA'S CLASSROOM === section is your CURRENT CONTEXT..."
- Considering: a "hidden first user message" (the classroom block injected as turn 1 of the conversation history)

## FILE 1: [prompt assembly code] ...

Questions:
1. Compare these with your stage-1 approach. Where is our reasoning weak? Would you do something else entirely?
2. For each candidate: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE, citing the code.
```

---

## After the review

- Write findings to `docs/gemini-3.5-audit-YYYY-MM-DD.md` for significant reviews, with the consult directory's exact requests next to the verbatim responses
- A recommendation is a suggestion to weigh, not an instruction (see `consult-gemini` Step 4). Ask why, and whether it fits HolaHola. **A recommendation to move Daniela to 3.5 is never applied automatically.** Changing her model is a primary-LLM change, which needs David's approval (replit.md, Tiered Autonomy) and goes through the normal reviewed release path. Bring David the evidence and the verdicts.
- Note: the consult model (`gemini-3.5-flash`) and the GL streaming model (`gemini-3.5-flash-live-preview`) are different endpoints — if a switch is approved, confirm the live model string works before switching Daniela

---

## Notes

- Temperature 0.3 for architectural analysis
- `--max-tokens 4000` usually sufficient; increase to 6000 for complex reviews
- Each consult directory keeps its own record, so a 3.1 run and a 3.5 run on the same prompts can be compared side by side
- If a response cuts off mid-sentence, run the next stage asking Gemini to continue; the history goes with it
