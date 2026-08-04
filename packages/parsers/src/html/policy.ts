/**
 * What HTML gets thrown away before anything is read, as data rather than as code.
 *
 * This is a versioned policy because **it changes what a build contains**. Dropping `<nav>`
 * removes text that would otherwise be indexed, so the policy is an input to the parser
 * version, and editing this file without bumping `HTML_NOISE_POLICY_VERSION` would let two
 * builds with the same id disagree about their contents.
 *
 * It is a deny list rather than an allow list, deliberately. An allow list silently drops
 * every element nobody thought of, and HTML in the wild is mostly elements nobody thought of.
 * Deny-by-name means an unknown element keeps its text and the failure mode is "too much
 * survived", which a reader can see, rather than "the page came out empty", which they cannot.
 */

export const HTML_NOISE_POLICY_VERSION = 1 as const;

/**
 * Removed with their contents. These carry no prose a reader would search for.
 *
 * `script` and `style` are the security-relevant pair: their text is code, and indexing it
 * would put executable-looking strings into search results and context bundles.
 */
export const DROPPED_WITH_CONTENT: readonly string[] = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'map',
  'form',
  'input',
  'select',
  'textarea',
  'button',
];

/**
 * Site chrome, removed with their contents when they are page-level landmarks.
 *
 * Kept separate from the list above because these are a *judgement*: a `<header>` inside an
 * `<article>` is usually that article's own heading and worth keeping, while a `<header>` at
 * the top of the page is a logo and a menu. The parser applies these only outside `article`
 * and `main`, which is the distinction the HTML spec already draws.
 */
export const CHROME: readonly string[] = ['nav', 'header', 'footer', 'aside'];

/** Elements that begin a region where chrome is content rather than furniture. */
export const CONTENT_LANDMARKS: readonly string[] = ['article', 'main'];

/**
 * How much removed text counts as "substantial" enough to warn about.
 *
 * A page that is 90% navigation is a page whose build will disappoint someone, and #71 asks
 * for that to be visible rather than silent. The threshold is a fraction of the text a
 * lenient parse found, so it does not fire on a small page with a normal menu.
 */
export const SUBSTANTIAL_REMOVAL_FRACTION = 0.5;
