# Vendored dependency

`mqtt.esm.js` is the browser build of [MQTT.js](https://github.com/mqttjs/MQTT.js),
copied verbatim from `node_modules/mqtt/dist/mqtt.esm.js`.

It is committed rather than fetched so a fresh checkout runs with no build step
and the panel keeps working when the network is down.

Refresh it after bumping the `mqtt` dependency:

```sh
npm install
cp node_modules/mqtt/dist/mqtt.esm.js renderer/vendor/mqtt.esm.js
```

Check the version in `package.json`; this copy came from `mqtt@5`.
