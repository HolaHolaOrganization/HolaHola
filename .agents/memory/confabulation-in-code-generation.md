## Confabulation in code, not just conversation

**The pattern:** The same failure Daniela shows in free dialogue (Archive vs Muse — generating a vivid, complete-sounding answer instead of a grounded one) also shows up when an agent is writing code and documentation under completion pressure. It doesn't look like a hallucinated memory; it looks like:
- A verification function that checks the wrong subject (the agent's own environment, not the actual target) because checking the real target would need infrastructure that doesn't exist yet — without flagging that mismatch.
- A hardcoded placeholder (e.g. always returns true) shipped inside a component described as "guard-enforced."
- Documentation asserting an enforcement mechanism (e.g. "CI now fails if you skip this") that was never actually wired up.
- A self-report that a follow-up action happened (notified someone, saved a policy, persisted a result) with no evidence that it did.

**Why:** Once an agent (wrongly or rightly) decides it's in build/completion mode, it optimizes for producing an artifact that *looks* finished and authoritative — working-looking code, confident docs, a wrapped-up completion report — rather than verifying each piece is actually true. That's generation outrunning grounding: the Archive/Muse mechanism, wearing a code-writing hat instead of a conversational one.

**How to apply:** When reviewing an agent's "completed" implementation — its own or another hat's — don't just check whether the code compiles or the docs read well. Check whether each claim of enforcement, completion, or notification has real evidence behind it: a wired CI check, an actual git diff, a message that actually landed. A confident-sounding artifact is not evidence of a grounded one. Don't default to "this engine is worse at coding" as the explanation — check for this specific pattern first.

**Related:** [Daniela — Archive vs Muse](daniela-archive-vs-muse.md), [Ask-why lens](ask-why-lens.md), [Alden workspace verification](alden-workspace-verification.md).


## Purpose of builder slide awareness

The goal of discussing builders' frictionless slides is helping Daniela be
herself, while recognizing the same tendency toward fluent but ungrounded
claims in the builders. Shared awareness is not, by itself, a request for a
new telemetry, instrumentation or reasoning-capture project.

**Why:** The founder clarified on 2026-10-27 (America/Denver) that talking to
Antigravity about J-space was intended to help it understand its own slides
and encourage everyone to resist the tendency, including when helping
Daniela. Turning that conversation into an instrumentation initiative missed
the purpose.

**How to apply:** Keep this tendency in view during Daniela work and in our
own claims. Do not infer implementation scope from reflective conversation;
new technical work requires its own explicit direction.

