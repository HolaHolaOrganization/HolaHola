import { resolve } from 'node:path';
import { prepareAntigravityProvisioning } from './prepare-antigravity-provisioning';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function run(): Promise<void> {
  const startingCommit = option('--starting-commit');
  if (!startingCommit) throw new Error('missing_starting_commit');
  const bundle = await prepareAntigravityProvisioning({
    startingCommit,
    templatePath: resolve(process.cwd(), 'server/templates/task-1448.md'),
  });
  process.stdout.write(`${JSON.stringify(bundle)}\n`);
}

run().catch(() => {
  process.stderr.write('antigravity_provisioning_failed\n');
  process.exitCode = 1;
});