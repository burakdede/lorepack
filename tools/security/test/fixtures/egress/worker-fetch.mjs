// Counterexample from #616: a worker thread has its own global `fetch`.
import { Worker } from 'node:worker_threads';

new Worker("fetch('http://127.0.0.1:2/build-id').catch(() => {})", { eval: true });
