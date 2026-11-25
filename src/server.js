'use strict';
const { createConfig } = require('./config/index');
const { createApp } = require('./app');
const config = createConfig();
const app = createApp({ config });
const server = app.listen(config.port, config.host, () => console.log(`Anime Element Studio: http://${config.host}:${server.address().port} — local CPU, không cần API key`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.locals.close(); server.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
