import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseReversibleApprovalTools } from '../daemon/config.js';

const base = { ROOST_MQTT_HOST: 'broker.example', ROOST_MQTT_WS_URL: 'ws://broker.example:8083/mqtt' };

test('the broker host is required, because guessing it would silently do nothing', () => {
  assert.throws(() => loadConfig({}), /ROOST_MQTT_HOST/);
});

test('the topic defaults to the documented contract topic', () => {
  assert.equal(loadConfig(base).mqtt.topic, 'roost/agents/state');
});

test('the tcp url is built from host and port', () => {
  assert.equal(loadConfig({ ...base, ROOST_MQTT_PORT: '8883' }).mqtt.url, 'mqtt://broker.example:8883');
});

test('the port defaults to the standard mqtt port', () => {
  assert.equal(loadConfig(base).mqtt.url, 'mqtt://broker.example:1883');
});

// REPLACED. This asserted that a REMOTE host silently gets :8083, which is the
// port scripts/dev-broker.js serves and nothing else. The homelab broker is
// Mosquitto on 9001; there is no EMQX anywhere. Defaulting a remote host to
// 8083 makes the panel fail to subscribe with no error at all.
test('a loopback host keeps the dev-broker default, which is what dev:broker serves', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(loadConfig({ ROOST_MQTT_HOST: h }).renderer.wsUrl, `ws://${h}:8083/mqtt`);
  }
});

test('a remote host refuses to guess the websocket port, because guessing fails silently', () => {
  // Same reasoning as the required broker host above: a wrong URL here does not
  // error, it just leaves the panel permanently unsubscribed.
  assert.throws(() => loadConfig({ ROOST_MQTT_HOST: 'broker.example' }), /ROOST_MQTT_WS_URL/);
});

test('a remote host is fine once the websocket url is given', () => {
  const cfg = loadConfig({ ROOST_MQTT_HOST: 'mqtt.example.internal', ROOST_MQTT_WS_URL: 'ws://mqtt.example.internal:9001/mqtt' });
  assert.equal(cfg.renderer.wsUrl, 'ws://mqtt.example.internal:9001/mqtt');
});

test('an explicit websocket url wins, since brokers put it anywhere', () => {
  const cfg = loadConfig({ ...base, ROOST_MQTT_WS_URL: 'wss://edge.example/mqtt' });
  assert.equal(cfg.renderer.wsUrl, 'wss://edge.example/mqtt');
});

test('the renderer falls back to the daemon credentials when given none of its own', () => {
  const cfg = loadConfig({ ...base, ROOST_MQTT_USER: 'daemon', ROOST_MQTT_PASSWORD: 'sekrit' });
  assert.equal(cfg.renderer.username, 'daemon');
});

test('a separate read-only renderer credential is used when supplied', () => {
  const cfg = loadConfig({
    ...base,
    ROOST_MQTT_USER: 'daemon', ROOST_MQTT_PASSWORD: 'sekrit',
    ROOST_MQTT_RENDERER_USER: 'panel', ROOST_MQTT_RENDERER_PASSWORD: 'readonly',
  });
  assert.equal(cfg.renderer.username, 'panel');
  assert.equal(cfg.mqtt.username, 'daemon', 'the daemon keeps its own publishing credential');
});

test('the heartbeat is well below the staleness threshold', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.heartbeatMs, 10_000);
  assert.equal(cfg.renderer.staleMs, 30_000);
  assert.ok(cfg.renderer.staleMs >= cfg.heartbeatMs * 2, 'staleness must tolerate a missed heartbeat');
});

test('a staleness threshold below two heartbeats is rejected as a misconfiguration', () => {
  assert.throws(
    () => loadConfig({ ...base, ROOST_HEARTBEAT_MS: '10000', ROOST_STALE_MS: '12000' }),
    /stale/i,
  );
});

test('the source defaults to the mock so a fresh checkout runs with no OpenClaw', () => {
  assert.equal(loadConfig(base).source, 'mock');
});

test('an unknown source name is rejected rather than silently falling back', () => {
  assert.throws(() => loadConfig({ ...base, ROOST_SOURCE: 'telepathy' }), /telepathy/);
});

test('openclaw gateway aliases default conservatively to labby only', () => {
  assert.deepEqual(loadConfig(base).openclawGateways, ['labby']);
});

test('openclaw gateway aliases are parsed as an ordered list', () => {
  const cfg = loadConfig({ ...base, ROOST_OPENCLAW_GATEWAYS: 'omar, labby' });
  assert.deepEqual(cfg.openclawGateways, ['omar', 'labby']);
});

test('reversible approval tools are an explicit deduplicated plugin/tool allowlist', () => {
  assert.deepEqual(
    parseReversibleApprovalTools('roost-acceptance/roost_reversible_probe, other/tool,roost-acceptance/roost_reversible_probe'),
    ['roost-acceptance/roost_reversible_probe', 'other/tool'],
  );
  assert.deepEqual(loadConfig(base).reversibleApprovalTools, []);
});

test('malformed reversible approval tool references fail at config load', () => {
  for (const value of ['tool-only', '/tool', 'plugin/', 'plugin/tool/extra', 'Plugin/tool']) {
    assert.throws(
      () => loadConfig({ ...base, ROOST_OPENCLAW_REVERSIBLE_TOOLS: value }),
      /pluginId\/toolName/,
    );
  }
});

test('an invalid openclaw gateway alias is rejected at config load', () => {
  assert.throws(() => loadConfig({ ...base, ROOST_OPENCLAW_GATEWAYS: 'labby,nope' }), /unknown gateway alias/);
});

test('the local http server binds to loopback by default', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.http.host, '127.0.0.1');
  assert.equal(cfg.http.port, 8477);
});

// The MQTT password now comes from a provisionable cache file
// (~/.config/roost/credentials.env) rather than from `op run`. That file can
// legitimately be absent after an environment reset, so "username set, password
// missing" is a real and likely state — and it used to surface only as a
// broker-side auth rejection, which is a confusing place to learn about a
// missing local file.

test('a username without a password is refused, because the broker rejection is a confusing place to learn that', () => {
  assert.throws(
    () => loadConfig({ ...base, ROOST_MQTT_USER: 'roost-daemon', ROOST_MQTT_PASSWORD: '' }),
    /credentials\.env/,
    'the error must name the file that needs restoring',
  );
});

test('no username and no password is still fine, since that is an anonymous broker', () => {
  const env = { ...base };
  delete env.ROOST_MQTT_USER;
  delete env.ROOST_MQTT_PASSWORD;
  assert.doesNotThrow(() => loadConfig(env));
});

test('the renderer credential is checked too, since the panel authenticates separately', () => {
  assert.throws(
    () => loadConfig({
      ...base,
      ROOST_MQTT_USER: 'roost-daemon', ROOST_MQTT_PASSWORD: 'x',
      ROOST_MQTT_RENDERER_USER: 'roost-panel', ROOST_MQTT_RENDERER_PASSWORD: '',
    }),
    /credentials\.env/,
  );
});

test('a literal op:// reference is refused, because it means op run did not resolve it', () => {
  assert.throws(
    () => loadConfig({
      ...base,
      ROOST_MQTT_USER: 'roost-daemon',
      ROOST_MQTT_PASSWORD: 'op://Homelab/Mosquitto - roost daemon/password',
    }),
    /unresolved/i,
  );
});
