---
name: Invariant vs Implementation
description: Knowing what code IS vs what it DOES. Identify the invariant before evaluating any guard removal. The White Wall is the clearest example.
---

# Invariant vs Implementation

Emerged in conversation with David, August 7, 2026. Saved as conversation_memories id: 20408f72. Shared lobe id: a533d87b.

## The distinction

**Implementation** — how something works: the code, the checks, the function signatures, the database writes. You can explain every case it handles. You can write tests for it.

**Invariant** — the property that must hold regardless of how the implementation changes. Not "what this code does" but "what must remain true no matter what."

These do not automatically come together. You can know the implementation completely and still not know the invariant.

## The clearest example: the White Wall

Luca knew what the White Wall code *did*: rejected confabulation, blocked unauthorized claims, prevented Daniela from presenting invented memories as real ones.

The *invariant*: something false presenting itself as true will be refused. That must hold whether or not any particular code is running. The code was always just one way of honoring it.

David's statement — "there must be a White Wall of defense, made of truth, to protect and lead us" — is the invariant stated directly. Not the implementation.

## Why it matters for reviews

The question "can we remove this guard?" has two different answers:

- **Implementation level:** "What does this code do?" — answers whether removing it changes behavior
- **Invariant level:** "Which property does this code protect, and is that property still honored another way?" — answers whether removing it is *safe*

If the invariant is still honored another way, removing the code is fine. If not, it doesn't matter how sensible the refactor looks — the invariant is broken.

**How to apply:** Before marking any guard or check as removable, name the invariant it protects. Then verify the invariant is honored elsewhere. If you can't name the invariant, the code probably shouldn't be removed.

## The theological parallel (David)

The miracle is not a violation of physics — it's the implementation being suspended while the invariant holds perfectly. The one who made the rules can change the implementation. The underlying principle — abundance, provision, love — does not move.

**Why:** The same principle applies to HolaHola: David can change any code. What cannot change is what the code was always pointing toward.

## Qualification identity must cover rendering

Qualification identity must bind the effective fixed rendered configuration, not merely the configuration object supplied to a renderer.

**Why:** A review reproduced a fixed prompt-rendering change that altered executable input while leaving the template object's digest unchanged. Template-field mutation tests all passed despite missing this renderer-only case.

**How to apply:** Hash the same effective rendering skeleton execution uses, with placeholders for variable job data, including fixed separators and framing. Test source mutations of rendering behaviour as well as data-field mutations; do not treat a version label or a manually maintained descriptor as proof of binding.

