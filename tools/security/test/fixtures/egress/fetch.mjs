// The route the first version of the test did stub: a plain `fetch`. Port 2, because fetch
// refuses the WHATWG "bad ports" such as 9 before any request exists.
fetch('http://127.0.0.1:2/build-id').catch(() => {});
