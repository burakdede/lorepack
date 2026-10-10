// Counterexample from #616: one UDP datagram, which no TCP hook sees.
import dgram from 'node:dgram';

const socket = dgram.createSocket('udp4');
socket.send('build-id', 9, '127.0.0.1', () => socket.close());
