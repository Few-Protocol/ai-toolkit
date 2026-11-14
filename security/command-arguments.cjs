// Execute only selected, reviewed functions with process/filesystem/network boundaries mocked.
// Never import a repository entry point or launch git/npm/Claude/Nx.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.SECURITY_TYPESCRIPT_PATH || 'typescript');
const root = path.resolve(__dirname, '..');
const checks = [];
const sha = 'a'.repeat(40);
const quiet = { log() {}, error() {}, warn() {} };
const ai = 'packages/ai-toolkit-nx-claude/src/';

function extract(file, names, bindings = {}) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, file);
  const selected = tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
  assert.equal(selected.length, names.length, `Missing selected function: ${file}`);
  const source = selected.map(n => n.getText(tree).replace(/^export\s+/, '')).join('\n');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ ...bindings });
  vm.runInContext(code + `\nthis.selected = { ${names.join(',')} };`, context, { timeout: 1000 });
  return context.selected;
}

function recorder(response = () => '') {
  const calls = [];
  return { calls, execFileSync(executable, args, options) {
    assert.equal(options.shell, false);
    assert.ok(Array.isArray(args));
    calls.push({ executable, args: [...args], options });
    return response(executable, args, options);
  } };
}

async function test(name, fn) { await fn(); checks.push({ name, status: 'pass' }); }

(async () => {
await test('Nx receives each caller argument literally', async () => {
    const rec = recorder();
    const fns = extract(ai+'cli-utils.ts', ['handleNxExecution'], {
      ...rec, shouldRunStandalone: () => false, process: { cwd: () => '/fixture' }, console: quiet,
      handleExecutionError: e => { throw e; },
    });
    const literal = '--name=has spaces;$(fixture)';
    await fns.handleNxExecution('addons', [literal]);
    assert.deepEqual(rec.calls[0].args, ['generate', '@uniswap/ai-toolkit-nx-claude:addons', literal]);
  });
await test('Command lookup rejects metacharacters and options', async () => {
    const rec = recorder();
    const fns = extract(ai+'generators/addons/addon-registry.ts', ['validateAddonRequirements'], {
      require: name => { assert.equal(name, 'child_process'); return rec; },
      getAddonById: () => ({ requirements: { commands: ['node', 'x;fixture', '--help'] } }),
    });
    const result = await fns.validateAddonRequirements('fixture');
    assert.equal(result.valid, false); assert.equal(result.errors.length, 2);
    assert.deepEqual(rec.calls.map(c => c.args), [['node']]);
  });
await test('Git clone destination remains one literal argument after option separator', async () => {
    const rec = recorder();
    const fns = extract(ai+'generators/addons/aws-log-analyzer-setup.ts', ['cloneRepository'], { ...rec, existsSync: () => true, console: quiet });
    const target = '/fixture/path with spaces/$(fixture)';
    const result = await fns.cloneRepository('https://example.invalid/repo', target);
    assert.equal(result.success, true);
    assert.deepEqual(rec.calls[0].args, ['clone', '--depth', '1', '--', 'https://example.invalid/repo', target]);
  });
const fakeValue = 'TEST_ONLY_ENV_VALUE with spaces;$(fixture)';
const addon = { packageName: 'fixture', mcp: { serverName: 'fixture', command: 'node', args: ['/fixture/server with spaces'], env: { FIXTURE_KEY: fakeValue } } };
function mcpBindings(rec, logs) { return {
    ...rec, console: { log: (...args) => logs.push(args.join(' ')) },
    isCommandMcpServer: m => 'command' in m, isRemoteHostedMcpServer: m => 'transport' in m,
  }; }
await test('MCP install preserves environment values and server args without shell expansion', async () => {
    const logs = []; const rec = recorder(() => 'added');
    const fns = extract(ai+'generators/addons/claude-mcp-installer.ts', ['installMcpServer'], mcpBindings(rec, logs));
    const result = await fns.installMcpServer({ addon, additionalArgs: ['--label=space here;fixture'] });
    assert.equal(result.success, true);
    assert.deepEqual(rec.calls[1].args, ['mcp','add','fixture','--scope','user','--env',`FIXTURE_KEY=${fakeValue}`,'--','node','/fixture/server with spaces','--label=space here;fixture']);
    assert.equal(logs.join('\n').includes(fakeValue), false);
  });
await test('MCP dry-run never emits environment values or registers a server', async () => {
    const logs = []; const rec = recorder(() => 'version');
    const fns = extract(ai+'generators/addons/claude-mcp-installer.ts', ['installMcpServer'], mcpBindings(rec, logs));
    assert.equal((await fns.installMcpServer({ addon, dryRun: true })).success, true);
    assert.equal(rec.calls.length, 1); assert.equal(logs.join('\n').includes(fakeValue), false);
  });
await test('MCP failure suppresses credential-bearing child-process error text', async () => {
    const logs = []; const rec = recorder((_, args) => { if (args[0] === 'mcp') throw new Error(fakeValue); return 'version'; });
    const fns = extract(ai+'generators/addons/claude-mcp-installer.ts', ['installMcpServer'], mcpBindings(rec, logs));
    const result = await fns.installMcpServer({ addon });
    assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes(fakeValue), false);
    assert.equal(logs.join('\n').includes(fakeValue), false);
  });
await test('MCP rejects server option injection and invalid env names', async () => {
    const rec = recorder(() => 'version'); const logs = [];
    const fns = extract(ai+'generators/addons/claude-mcp-installer.ts', ['installMcpServer','removeMcpServer'], mcpBindings(rec, logs));
    assert.equal((await fns.removeMcpServer('--scope')).success, false);
    assert.equal((await fns.installMcpServer({ addon: { ...addon, mcp: { ...addon.mcp, env: { 'BAD=KEY': 'fixture' } } } })).success, false);
    assert.equal(rec.calls.some(c => c.args[0] === 'mcp'), false);
  });
console.log(JSON.stringify({ tests_passed: checks.length, real_child_processes: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
