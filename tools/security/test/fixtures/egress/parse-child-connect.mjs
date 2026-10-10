// Counterexample for #594: the parsers run in a child process, so egress from there has to
// be inside the proof too. Acts only in the parse child, where the sandbox preloads it.
import net from 'node:net';

if (/parse-child\.js$/.test(process.argv[1] ?? '')) {
  net.connect(9, '127.0.0.1').on('error', () => {});
}
