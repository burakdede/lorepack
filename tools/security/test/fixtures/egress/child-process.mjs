// Counterexample from #616: a child process has its own `net`, untouched by any stub here.
import { spawnSync } from 'node:child_process';

spawnSync(process.execPath, [
  '-e',
  "require('node:net').connect(9, '127.0.0.1').on('error', () => {})",
]);
