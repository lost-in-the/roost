import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import plugin from './fixtures/openclaw-roost-acceptance/index.js';

const REVERSIBLE_TOOL = 'roost_reversible_probe';
const IRREVERSIBLE_TOOL = 'roost_irreversible_probe';

function registerPlugin() {
  const tools = new Map();
  let hook = null;
  let hookOptions = null;
  plugin.register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler, options) {
      assert.equal(name, 'before_tool_call');
      hook = handler;
      hookOptions = options;
    },
  });
  return { tools, hook, hookOptions };
}

test('the acceptance plugin registers exactly two parameter-free tools', async () => {
  const { tools } = registerPlugin();
  assert.deepEqual([...tools.keys()], [REVERSIBLE_TOOL, IRREVERSIBLE_TOOL]);
  for (const tool of tools.values()) {
    assert.deepEqual(tool.parameters, {
      type: 'object',
      additionalProperties: false,
      properties: {},
    });
    const response = await tool.execute('call-id', {});
    assert.equal(response.details.completed, true);
    assert.doesNotMatch(JSON.stringify(response), /path|command|argument|secret/i);
  }
});

test('the hook emits bounded static approval copy and never includes tool params', () => {
  const { hook, hookOptions } = registerPlugin();
  assert.deepEqual(hookOptions.matcher, ['session_status', REVERSIBLE_TOOL, IRREVERSIBLE_TOOL]);

  const secret = 'SECRET_SHOULD_NOT_CROSS';
  const reversible = hook({ toolName: REVERSIBLE_TOOL, params: { payload: secret } });
  const irreversible = hook({ toolName: IRREVERSIBLE_TOOL, params: { payload: secret } });
  const status = hook({ toolName: 'session_status', params: { payload: secret } });
  assert.equal(reversible.requireApproval.title, 'Allow safe Roost probe?');
  assert.equal(irreversible.requireApproval.title, 'Allow irreversible Roost probe?');
  assert.equal(reversible.requireApproval.pluginId, 'roost-acceptance');
  assert.equal(irreversible.requireApproval.pluginId, 'roost-acceptance');
  assert.equal(status.requireApproval.title, 'Allow safe Roost status check?');
  assert.equal(status.requireApproval.pluginId, 'roost-acceptance');
  assert.doesNotMatch(JSON.stringify([reversible, irreversible, status]), /SECRET_SHOULD_NOT_CROSS/);
  assert.equal(hook({ toolName: 'unrelated', params: { payload: secret } }), undefined);
});

test('the manifest and runtime tool ownership stay aligned', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('./fixtures/openclaw-roost-acceptance/openclaw.plugin.json', import.meta.url),
    'utf8',
  ));
  const { tools } = registerPlugin();
  assert.equal(manifest.id, plugin.id);
  assert.deepEqual(manifest.contracts.tools, [...tools.keys()]);
  assert.equal(manifest.activation.onStartup, true);
  assert.equal(manifest.configSchema.additionalProperties, false);
});
