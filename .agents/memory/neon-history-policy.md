## Founder-set seven-day Neon history

On 2026-10-30 the founder reported: "I increased the neon history/backup from 2 days to 7 per alden's desire. It was a free change." The supplied Neon settings screenshot shows the history window set to 7d and labeled as applying to all branches.

Treat the previous 48-hour setting and unresolved request to raise it as historical, not current. This records the founder's completed action and cost report, supported by the screenshot; it does not claim an independent live Neon API verification.

**Why:** The founder completed the longer-history change requested during the episode-backup design review; future planning must not repeatedly ask him to authorize that already-completed change.

**How to apply:** Describe the current founder-reported history window as seven days. This is Neon's point-in-time history, not an independently exported backup. Keep the approved S3 backup and restore-drill requirements separate, and do not change backup retention or destructive permissions on the strength of this update.


## R2 backup custody is provider-native

The backup destination uses Cloudflare R2. AWS-style GetBucketPolicy/GetBucketVersioning probes do not establish destructive-permission safety when unsupported or denied; evaluate the provider-native control plane instead.

**Why:** During the founder-authorized backup work, the object interface returned an unsupported policy read and denied versioning metadata. Treating either as proof of no-delete custody would have authorized unsafe uploads. Cloudflare documents that R2 bucket locks protect overwrite/deletion (including lifecycle) and can be scoped to a prefix; administrative control of those rules must stay separate from exporter object access.

**How to apply:** Verify provider-native protection and credential custody before a live backup. Do not apply a blanket lock to the existing app bucket or infer that S3 compatibility includes AWS IAM/versioning semantics. Prefix locks and retention choices need explicit founder authorization. Cloudflare also checks its locks before conditional-write headers: an existing locked object can yield ObjectLockedByBucketPolicy409 rather than PreconditionFailed412; accept reuse only after independent exact readback. Sources: https://developers.cloudflare.com/r2/buckets/bucket-locks/ and https://developers.cloudflare.com/r2/api/tokens/ .


## Founder-selected indefinite backup protection

On 2026-10-30 the founder selected "Until you explicitly unlock them" in response to the question about how long backup objects should remain protected.

This authorizes indefinite protection for the narrow `episode-backups/v1/` prefix only. It does not authorize locking the whole app bucket or its existing media prefixes, automatic deletion, removing any lock, or supplying lock-management credentials to the exporter. Lock-management authority must remain separately founder-controlled.

**Why:** The founder explicitly selected indefinite protection rather than a fixed retention period. Backup preservation must not expire automatically while the exporter can still delete or overwrite older objects.

**How to apply:** Prepare and independently verify a provider-native indefinite R2 prefix lock, keeping bucket-configuration authority outside the exporter. Future cleanup/unlocking requires the founder's explicit authorization. Selection of this policy is not evidence that it has been applied.

Operational status: the existing Cloudflare credential received HTTP403/code10000 from the read-only R2 lock configuration endpoint. No lock configuration was read or changed. A founder-controlled dashboard step or separately authorized administrative executor is required; do not request or expose an admin credential in chat.


## Independent episode backup retention and custody

The founder selected “Until you explicitly unlock them” for episode/story backups on 2026-10-30. Protect only `episode-backups/v1/` indefinitely; never lock the whole application bucket or media prefixes. Lock-management custody stays with the founder, not the exporter. Keep authored Markdown until separately authorized retirement, even after a successful drill.

**Why:** The founder explicitly chose non-expiring protection while retaining control of unlocking. A successful backup is not permission to delete or retire another authentic record.

**How to apply:** Preserve this retention and custody boundary for future backup scheduling and recovery work; any unlocking, deletion policy or Markdown retirement needs separate explicit authorization.

