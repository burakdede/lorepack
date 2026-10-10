// Counterexample for #594: the sandbox lets the parse child's fork through only when the
// child is itself under the permission model. The same module path without it is refused.
import { fork } from 'node:child_process';

fork('parse-child.js', [], { execArgv: [] });
