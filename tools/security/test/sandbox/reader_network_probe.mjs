import net from 'node:net';
import { isMainThread, workerData } from 'node:worker_threads';

if (!isMainThread && workerData?.role === 'lorepack-linux-resident-reader') {
  net.connect(9, '127.0.0.1').on('error', () => {});
}
