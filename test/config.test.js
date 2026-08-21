import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../daemon/config.js';

const base = { ROOST_MQTT_HOST: 'broker.example' };

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

test('the browser websocket url is derived from the host when not given', () => {
  assert.equal(loadConfig(base).renderer.wsUrl, 'ws://broker.example:8083/mqtt');
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

test('the local http server binds to loopback by default', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.http.host, '127.0.0.1');
  assert.equal(cfg.http.port, 8477);
});
