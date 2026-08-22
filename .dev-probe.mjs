import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: process.execPath, args: ['apps/mcp/src/dev-index.ts'], stderr: 'pipe',
  env: { ...process.env, JUMPCUT_REPO: process.cwd() } });
const c = new Client({ name: 'fake-hermes-dev', version: '1' });
await c.connect(t);
const tools = await c.listTools();
console.log('dev tools:', tools.tools.map(x => x.name).join(', '));
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).content.map(x => x.text ?? '').join('\n');
const step = process.argv[2];
if (step === 'tests') console.log('\n=== run_tests ===\n' + await call('run_tests'));
if (step === 'status') console.log('\n=== git_status_diff (no patch) ===\n' + (await call('git_status_diff', { patch: false })));
if (step === 'checkpoint') console.log('\n=== git_checkpoint ===\n' + await call('git_checkpoint', { message: process.argv[3] || 'checkpoint' }));
if (step === 'revert') console.log('\n=== git_revert_last ===\n' + await call('git_revert_last'));
if (step === 'logs') console.log('\n=== app_logs ===\n' + await call('app_logs', { lines: 5 }));
await c.close();
