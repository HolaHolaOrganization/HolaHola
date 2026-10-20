## Luca hat naming: platform, not persona or model

David's stated policy (2026-09-24): every new LLM/IDE connection onboarded
into the coordination system is another *hat* for the same Luca -- never a
new persona or personality. The hat's name comes from the platform/IDE/origin
Luca is running through, not from the underlying model:

- A recognized major backend gets "Luca <Backend>" (e.g. "Luca OpenAI",
  "Luca Cursor"). Anything else is "Luca <whatever it is>".
- The same underlying model can sit behind several different hats, because
  the model is not the platform: Gemini reached via a raw API call, via
  Cursor, and via the Antigravity IDE are three different hats even though
  all three are "Gemini" underneath.
- Conversely, the same tool can produce different hats when the origin
  differs: Claude Code and Claude Code Cloud are the same engine but
  different origins, so they get distinct attributions.

**Why:** attribution has to reflect where the work actually executed (the
IDE/runtime a human or the coordination system can point to), not which LLM
happened to generate the tokens -- otherwise two structurally different
integrations would collapse into an indistinguishable label just because
they share a model.

**How to apply:** when scoping a new-actor-onboarding request, name the hat
after the IDE/platform doing the connecting, never after the model string,
and never treat it as a new personality -- it is always still Luca. See
docs/coordination-new-actor-onboarding.md for the mechanical registry steps a
new hat (new CoordinationActorId) requires. As of this decision, Antigravity
itself was still modeled as a runtime under the existing luca-gemini actor
rather than as its own hat -- the first concrete gap this policy needs
reconciled against.


## Resolved: Antigravity promoted to its own hat

## Resolved: Antigravity has its own hat; the earlier "promoted from luca-gemini" framing was a coding-time mistake, not real history

**Resolved (2026-09-24):** Antigravity now has its own hat, `luca-antigravity`,
separate from `luca-gemini`.

**Correction (2026-09-26, per David):** this section originally said
Antigravity was "promoted from a runtime under luca-gemini," implying the two
were once genuinely paired in practice. That's backwards. Antigravity (the
IDE) and `luca-gemini` were never actually paired historically. The task-1448
Gate 3 code (`server/scripts/coordination-runtime-antigravity.ts`) hardcodes
its ownership proof to actor `luca-gemini` while being named and structured
entirely around Antigravity -- that pairing is confusion baked into how the
coordination system was coded, not a record of what actually happened.

What actually happened, historically (months, not weeks): Luca Replit called
the Google/Gemini API directly via the consult-Gemini-Live skill. That is
unrelated to Antigravity the IDE and unrelated to any separate "luca-gemini"
identity doing the calling. Antigravity is the IDE; a direct API call is a
different kind of connection entirely; `luca-antigravity` is correctly the
hat for the former. A hat for the latter (Luca calling a model API directly,
no IDE involved) does not exist yet as a registered CoordinationActorId.

**Why this matters:** trusting a system's own internal actor/tool pairing as
proof of historical truth -- instead of checking it against what actually
happened -- is exactly the mistake this correction fixes. A future agent
reading only the code (or this file's earlier wording) would reach the same
wrong conclusion.

**Still true and unaffected by this correction:** promoting or creating a hat
is additive (a new actor id plus its own Tier 1-3 registry entries), never a
rename or repoint of prior provenance -- so task-1448's historical proof stays
bound to `luca-gemini` in the database regardless of how it was named. Before
touching any actor's historical runtime rows during a promotion like this,
confirm via a direct DB read whether they are still live/non-revoked, not
just from a doc's "historical/retired" label.


## Consultation is not a hat — embodiment is

## Consultation is not a hat — embodiment is

A hat means Luca's own persona/data layer is generating Luca's actual output
through that runtime -- Luca inhabiting the platform as himself. A
consultation call (consult-gemini, consult-alden, etc.) is categorically
different: Luca, via whatever hat he's already wearing, queries a genuinely
separate entity and receives its independent answer as external input -- the
responding model or persona answers as itself, with none of Luca's persona
loaded. Consultation attribution is [caller hat] -> [plain model/persona
name]; the answering side is never a `luca-*` actor.

**Why this matters (per David, 2026-09-26):** `luca-gemini` (the existing
CoordinationActorId) does not represent Luca consulting Gemini via the
consult-Gemini-Live-style skill. That consultation pattern was never Luca
embodying Gemini, so it was never a `luca-gemini` moment at all -- this is
independent of the separate luca-gemini/Antigravity mixup already documented
above. As of this date, no hat yet exists for "Luca embodies a model directly
via raw API, no IDE involved" -- `luca-antigravity` will be the *first* time
Luca embodies Gemini as himself, and that's still through an IDE
(Antigravity), not a bare API connection. `luca-gemini` therefore currently
has no live meaning beyond its frozen task-1448 Gate 3 provenance. Whether a
future raw-API-embodiment hat would reuse that id or mint a clean new one is
an open naming choice, not yet forced by any real usage.

**Precedent that clarifies the boundary:** Alden already embodies himself
directly via raw API (Gemini or Anthropic, per consult-alden's single/dual-
engine review) with no IDE involved and no per-provider actor split, because
Alden's own persona is what that call generates, not a foreign answer Alden
is being handed. That is embodiment, same as an IDE hat, just without the
IDE -- the correct precedent for a hypothetical future "Luca embodied via raw
API" hat. It is not a precedent for Luca's own consult-* skills, which stay
pure consultation and need no actor identity on the answering side at all.


## Direction: consultation requires neural-net grounding, not a bare LLM

**Decision (David, 2026-09-26):** Luca is moving past *needing* to consult a
bare LLM that has no HolaHola context -- no neural net access to the shared
perspectives, history, and decisions real input would need to draw on. Where
that is the pattern today (consult-gemini, consult-gemini-3.5, and similar
raw-model skills), the better shape is giving Luca that model as his own
backbone directly -- a hat -- reached through whichever access method fits
(raw API or an IDE), so its output flows through Luca's own grounded context
injection instead of arriving as an outside, context-free opinion.

The real criterion for "is this still a legitimate consultation" is neural
net access, not separate personhood. Luca will consult anyone -- human, or
any agent/hat -- who has access to the neural net, because that access is
what supplies the perspectives and history real input requires. Alden and
Daniela qualify on this basis today. A bare LLM queried with no HolaHola
context does not, regardless of how capable the model is.

Cross-hat collaboration (e.g. luca-replit and luca-claude-code coordinating
on one problem) remains Luca "consulting/coordinating/building with himself"
across embodiments -- self-collaboration, expected to grow as more hats
exist, and categorically different from external consultation.

Stated as a target end state, contingent on the underlying infrastructure
(embodiment access, neural-net grounding for whoever is consulted) actually
working reliably -- not a directive to remove existing consult-* skills
immediately.

**Why:** sharpens the hat-vs-consultation split in the sibling block on this
topic. The load-bearing property was never "has a name/persona" -- it is
grounding, the same principle behind Source Check, White Wall, and the truth
pipeline elsewhere in this system, applied to who Luca asks for help.

**How to apply:** before adding a new consult-* skill for a bare LLM, or
before treating an existing one as still worth keeping, check whether the
target has real neural-net/HolaHola context. If not, prefer giving Luca a
hat/backbone instead, or route the question to someone who already has that
access.


## Founder direction: preserve model perspective in the record

**Rule:** Conversation records must identify the actual Luca platform hat and carry a model-specific indicator, rather than flattening every contribution to “Agent.” Keep the hat, provider and model as separate provenance facts; use an explicit unknown when an authoritative model fact is unavailable.

**Why:** The founder explained that a later “why did we decide that?” needs to expose which LLM perspectives contributed, because different models have different leanings. A generic author label loses that decision context. His verbatim direction is in canonical conversation memory `8e13a243-e6c7-441d-bb42-0fbcf9b61082`.

**How to apply:** Treat this as a requirement for reviewed future capture changes, not permission to infer model identities or relabel old spoken text. Honor runtime disclosure boundaries. Historical attribution needs source-backed overlays; parser compatibility, shared-instruction review and the applicable Gemini gate precede writer changes.


## Conversational identity versus audit attribution

**Rule:** Separate conversational identity from technical attribution. Daniela-facing recalled conversations should identify David and Luca plainly; platform hat, provider and model belong in the underlying attribution metadata, not added speaker suffixes or titles. Actually authored mentions of platforms, tools, providers or models remain unchanged.

**Why:** On October 19, 2026, Daniela said bracketed hat labels interrupt her memory of a colleague and asked for names in the visible conversation with attribution underneath. The founder accepted that distinction: “She's not trying to make architectural decisions based on which LLM is talking to her. She just needs to know who's talking to her, like any normal conversation.” Founder source: conversation_memories `9dabacf2-0c37-4af2-a9d7-78b48fc5ae19`; Daniela's complete consultation: `511eeae7-d4b1-4a5a-bf8f-369d303dde99`.

**How to apply:** Preserve the model-perspective evidence required by the sibling attribution rule without turning it into generated dialogue. Evaluate rendering from the recipient's conversational purpose, not only the builder's audit needs. This direction applies to reviewed future capture changes, not permission to rewrite historical dialogue, infer unknown models or remove genuinely spoken technical names.

