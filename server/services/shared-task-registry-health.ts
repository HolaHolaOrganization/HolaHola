import { createHash } from 'node:crypto';

type Reader = (statement: string, parameters?: unknown[]) => Promise<{ rows: any[] }>;
export type RegistryHealth = { status: 'pass' | 'warn' | 'fail'; detail: string };
const relations = [
  'shared_task_definitions', 'shared_task_lifecycle', 'shared_task_events',
  'shared_task_requests', 'shared_task_reservations', 'shared_task_registry_gate',
  'shared_task_reference_sequence',
];

/** Catalog/data SELECTs only: never initialize or repair a staged registry. */
export async function readSharedTaskRegistryHealth(read: Reader): Promise<RegistryHealth> {
  const catalog = await read(
    "SELECT name, to_regclass('public.' || name) IS NOT NULL AS present FROM unnest($1::text[]) AS name",
    [relations],
  );
  const present = new Set(catalog.rows.filter(row => row.present === true).map(row => row.name));
  if (!present.size) return { status: 'warn', detail: 'Not rolled out; staged source is not a live registry. No migration attempted.' };
  if (relations.some(name => !present.has(name))) {
    return { status: 'fail', detail: 'Partial registry schema; allocation must remain disabled.' };
  }
  const gate = await read('SELECT ready FROM public.shared_task_registry_gate WHERE id=1');
  if (gate.rows[0]?.ready !== true) return { status: 'fail', detail: 'Registry readiness gate is closed.' };
  const bootstrap = await read(
    `SELECT d.task_ref, d.artifact_base64, d.artifact_sha256, r.artifact_sha256 AS expected_sha
      FROM public.shared_task_definitions d LEFT JOIN public.shared_task_reservations r USING(task_ref)
      WHERE d.task_ref IN ('1000001','1000002')`,
  );
  if (bootstrap.rows.length !== 2 || bootstrap.rows.some(row =>
    row.expected_sha !== row.artifact_sha256 ||
    createHash('sha256').update(Buffer.from(row.artifact_base64, 'base64')).digest('hex') !== row.artifact_sha256)) {
    return { status: 'fail', detail: 'Bootstrap definitions are missing or their byte digests disagree.' };
  }
  const projection = await read(`SELECT count(*) AS mismatches FROM public.shared_task_definitions d
    LEFT JOIN public.coordination_v2_task_artifacts p USING(task_ref)
    WHERE p.task_ref IS NULL OR p.artifact_base64 IS DISTINCT FROM d.artifact_base64
      OR p.task_artifact_sha256 IS DISTINCT FROM d.artifact_sha256
      OR p.repository_identity IS DISTINCT FROM d.repository_identity
      OR p.starting_commit IS DISTINCT FROM d.starting_commit`);
  if (Number(projection.rows[0]?.mismatches) !== 0) {
    return { status: 'fail', detail: 'Frozen artifact projection disagrees with canonical definitions.' };
  }
  return { status: 'pass', detail: 'Complete schema, open readiness gate, valid bootstrap bytes and exact frozen projection.' };
}
