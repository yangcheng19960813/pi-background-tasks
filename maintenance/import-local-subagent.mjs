// Import only from a user-authorized local source; never modify that source.
// The source archive is retained alongside generated execution-only JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = process.argv[3] ? require(path.resolve(process.argv[3])) : require('typescript');
const sourceDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node maintenance/import-local-subagent.mjs <source-dir> [typescript-module]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(root, 'maintenance', 'subagent-source');
const target = path.join(root, 'src', 'core', 'subagent', 'vendor');
fs.mkdirSync(archive, { recursive: true });
fs.mkdirSync(target, { recursive: true });
for (const name of ['index.ts', 'agents.ts', 'transcript-store.ts']) {
  const text = fs.readFileSync(path.join(sourceDir, name), 'utf8');
  fs.writeFileSync(path.join(archive, name), text, { flag: 'wx' });
  let body = text;
  let outputName = name.replace(/\.ts$/, '.js');
  if (name === 'index.ts') {
    const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const install = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
    if (!install?.body) throw new Error('Original subagent default installer was not found');
    const registration = install.body.statements.find((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.arguments[0] && ts.isObjectLiteralExpression(item.expression.arguments[0]));
    const definition = registration?.expression.arguments[0];
    const method = definition?.properties.find((item) => ts.isMethodDeclaration(item) && item.name.getText(ast) === 'execute');
    if (!method?.body) throw new Error('Original subagent execute method was not found');
    // No SDK session, Proxy registration, or ctx.executeTool; export the actual workflow body.
    body = text.slice(0, install.getFullStart()) + '\nexport { SubagentParams };\n' +
      'export async function executeSubagent(_toolCallId, params, signal, onUpdate, ctx) ' + method.body.getText(ast) + '\n';
    outputName = 'executor.js';
  }
  body = body.replaceAll('./agents.ts', './agents.js').replaceAll('./transcript-store.ts', './transcript-store.js');
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: name });
  fs.writeFileSync(path.join(target, outputName), '// Derived from the user-provided local subagent source; see maintenance/subagent-source.\n' + compiled.outputText, { flag: 'wx' });
}
console.log('SUBAGENT_CORE_IMPORTED: execution, role discovery, transcript; original files unchanged');
