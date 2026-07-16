#!/usr/bin/env node

import { runSetup } from '../src/setup.mjs';

runSetup().catch((error) => {
  process.stderr.write(`WaveInflu setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
