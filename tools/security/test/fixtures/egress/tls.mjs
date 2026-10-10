// A TLS connection, which reaches the network through `net` like every TCP client.
import tls from 'node:tls';

tls.connect(9, '127.0.0.1').on('error', () => {});
