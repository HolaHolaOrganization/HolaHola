/**
 * Lists every setInterval/setTimeout/setImmediate call in server/ (excluding
 * tests and scripts) whose nearest enclosing function is NOT a nested
 * callback, i.e. timers that start when a module is imported or when a
 * registration function such as registerRoutes() runs. Used to audit which
 * timers exist outside the instance-role gate (plan efb1e3d1 S2.2, review R2).
 *
 * Usage: npx tsx server/scripts/audit-boot-timers.ts [--json]
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface BootTimer {
  file: string;
  line: number;
  call: string;
  /** 'module' = runs at import; otherwise the name of the enclosing top-level function. */
  scope: string;
}

const TIMERS = new Set(['setInterval', 'setTimeout', 'setImmediate']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'scripts' || name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name.getText();
  }
  return undefined;
}

/**
 * The scope that executes the timer call directly: walks up through enclosing
 * functions. A timer is "boot-time" when the first function boundary above it
 * is a named top-level function (or there is none: module scope). If the first
 * boundary is an anonymous callback (a request handler, a .then, another
 * timer), it runs later, on demand, and is not reported.
 */
function bootScope(call: ts.Node): string | null {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isFunctionLike(node)) {
      const name = functionName(node);
      if (!name) return null;
      // Only top-level declarations count as boot-time registration scopes.
      const top = ts.isSourceFile(node.parent)
        || (ts.isVariableDeclaration(node.parent) && ts.isSourceFile(node.parent.parent?.parent?.parent));
      return top ? name : null;
    }
    node = node.parent;
  }
  return 'module';
}

export function auditBootTimers(root = join(process.cwd(), 'server')): BootTimer[] {
  const files: string[] = [];
  walk(root, files);
  const found: BootTimer[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/set(Interval|Timeout|Immediate)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TIMERS.has(node.expression.text)) {
        const scope = bootScope(node);
        if (scope) {
          found.push({
            file: relative(process.cwd(), file).replace(/\\/g, '/'),
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            call: node.expression.text,
            scope,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  const timers = auditBootTimers();
  if (process.argv.includes('--json')) console.log(JSON.stringify(timers, null, 2));
  else for (const t of timers) console.log(`${t.file}:${t.line}  ${t.call}  [${t.scope}]`);
}
