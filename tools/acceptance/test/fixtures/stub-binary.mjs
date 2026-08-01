#!/usr/bin/env node
// A stand-in for the `lore` binary, used to test the runner itself.
//
// The runner is the thing that has to be trustworthy: it is what proves the product
// behaves, so a bug in it is invisible in exactly the way #146 was. Driving it against a
// binary whose behaviour is known makes its own assertions checkable.
//
// It accepts the same `--cwd <path>` prefix the runner always passes, then one verb.
const argv = process.argv.slice(2);
const cwdIndex = argv.indexOf('--cwd');
const args = cwdIndex === -1 ? argv : [...argv.slice(0, cwdIndex), ...argv.slice(cwdIndex + 2)];
const [verb, ...rest] = args.filter((arg) => arg !== '--json');

switch (verb) {
  case 'ok':
    process.stdout.write('all good\n');
    process.stderr.write('some progress\n');
    break;

  case 'json':
    process.stdout.write(
      `${JSON.stringify({ id: 'stub', counts: { items: 3 }, list: [{ name: 'first' }] }, null, 2)}\n`,
    );
    break;

  case 'fail':
    process.stderr.write('error: it went wrong\n  code: LORE_E_STUB\n');
    process.exit(Number(rest[0] ?? 1));
    break;

  case 'echo':
    process.stdout.write(`${rest.join(' ')}\n`);
    break;

  case 'busy': {
    // Handles the signal rather than dying from it, which is what the real binary does and
    // what makes "the signal arrived" a meaningful assertion.
    let interrupts = 0;
    process.on('SIGINT', () => {
      interrupts += 1;
      if (interrupts >= 2) process.exit(130);
      process.stderr.write('stub interrupted\n');
      process.exit(17);
    });
    process.on('SIGTERM', () => {
      process.stderr.write('stub terminated\n');
      process.exit(18);
    });
    setTimeout(() => {
      process.stdout.write('finished without interruption\n');
    }, 30_000);
    break;
  }

  default:
    process.stderr.write(`unknown stub verb: ${String(verb)}\n`);
    process.exit(64);
}
