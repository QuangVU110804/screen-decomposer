'use strict';
const { createConfig } = require('../src/config/index');
const { engineStatus } = require('../src/integrations/python/worker');
engineStatus(createConfig()).then(status => { console.log(JSON.stringify(status, null, 2)); if (!status.ready) process.exitCode = 1; });
