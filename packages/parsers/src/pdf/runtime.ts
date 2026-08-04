/**
 * The three browser globals `pdfjs-dist` needs to load under Node, and why they are here.
 *
 * The reality check on #72 said to use the legacy build **rather than** polyfilling. That was
 * true while `@napi-rs/canvas` was in the tree, because canvas supplies `DOMMatrix` and pdfjs
 * picks it up silently. It is not true once canvas is removed, and canvas has to be removed:
 * it is a native module, and invariant 7 says the core install never compiles a binary. With
 * it gone, `pdfjs-dist@6.2.108`'s legacy build throws at *module load*:
 *
 *     const SCALE_MATRIX = new DOMMatrix();
 *     ReferenceError: DOMMatrix is not defined
 *
 * So the answer is the legacy build **and** these stubs, not one or the other.
 *
 * They are deliberately useless. Lorepack extracts a text layer and never renders a page, so
 * nothing here is ever called to do arithmetic; they exist to satisfy a module-level `new`.
 * Writing a real matrix implementation would be worse: it would look like rendering support
 * that works, and the first person to rely on it would find out otherwise.
 *
 * Assigned with `??=` so a host that already has the real thing keeps it, and assigned once at
 * import rather than per parse, because mutating a global per call is a race waiting to
 * happen. This is the only place in Lorepack that touches `globalThis`, and it is confined to
 * this module so the arch rules can see it in one diff.
 */

class StubMatrix {
  readonly a = 1;
  readonly b = 0;
  readonly c = 0;
  readonly d = 1;
  readonly e = 0;
  readonly f = 0;
  translate(): this {
    return this;
  }
  scale(): this {
    return this;
  }
  multiply(): this {
    return this;
  }
  invertSelf(): this {
    return this;
  }
}

const globals = globalThis as Record<string, unknown>;
globals.DOMMatrix ??= StubMatrix;
globals.Path2D ??= class {};
globals.ImageData ??= class {};

/** True when this process is relying on the stubs rather than a real browser environment. */
export const usingStubs = globals.DOMMatrix === StubMatrix;
