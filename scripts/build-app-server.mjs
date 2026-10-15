// npm aliases expose esbuild's same CLI bin name. Resolve the application's
// own API explicitly so the historical compiler cannot shadow an app upgrade.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  platform: 'node',
  packages: 'external',
  bundle: true,
  format: 'esm',
  outdir: 'dist',
});
