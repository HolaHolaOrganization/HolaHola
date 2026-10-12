## Internal ranges are not external guarantees

Treat an internal high-number allocation range as project policy, not as a
guarantee about the upper bound of externally assigned task identifiers.
Keep global collision detection even when ranges are intended to be disjoint.

**Why:** A cross-hat registry proposal treated a high allocation floor as proof
that Replit references could never overlap, without an authoritative platform
limit. The independently reviewed design instead makes overlap an explicit
conflict rather than silently sharing or overwriting a reference.

**How to apply:** Preserve imported references and fail closed on a differing
existing definition. Do not infer external numbering guarantees from a project's
own chosen allocation floor.

