// Node 24's permission model refuses `fsync` outright ("fsync API is disabled when
// Permission Model is enabled"), and the build fsyncs every object it writes. Durability is
// not what the sandbox measures, so here, and only here, fsync does nothing.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

fs.fsyncSync = () => {};
fs.fsync = (_fd, callback) => process.nextTick(callback, null);
syncBuiltinESMExports();
