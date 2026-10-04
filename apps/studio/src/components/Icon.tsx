/**
 * The shell's icon set: authored 16px line icons on one 1.5 stroke.
 *
 * Shell only. Route bodies carry no SVG at all, and their tests assert it, because inside a
 * route an SVG is how a chart or a gauge starts. In the sidebar and the command palette an
 * icon is a wayfinding mark beside a word, never instead of one.
 */
const PATHS = {
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  sources: (
    <>
      <path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5Z" />
      <path d="M9.5 1.75V5h3.25" />
      <path d="M5.75 8.25h4.5M5.75 10.75h3" />
    </>
  ),
  tables: (
    <>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
      <path d="M2 6.25h12M2 9.75h12M6.25 6.25v7" />
    </>
  ),
  playground: (
    <>
      <path d="M6 1.75v4.5L2.6 12.2a1 1 0 0 0 .87 1.55h9.06a1 1 0 0 0 .87-1.55L10 6.25v-4.5" />
      <path d="M5 1.75h6M4.25 9.75h7.5" />
    </>
  ),
  versions: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v4M8 10.25v4" />
    </>
  ),
  diagnostics: <path d="M1.75 8h2.5l1.75-4.5 3.5 9 1.75-4.5h3" />,
  search: (
    <>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="m10.5 10.5 3.25 3.25" />
    </>
  ),
  system: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.25" />
      <path d="M5.5 13.75h5M8 11.25v2.5" />
    </>
  ),
  light: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </>
  ),
  dark: <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z" />,
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25" />
      <path d="M10.75 5.25v-2a1 1 0 0 0-1-1h-6.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h2" />
    </>
  ),
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { readonly name: IconName }): React.JSX.Element {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Lorepack mark: three stacked builds, the newest on top. */
export function Mark(): React.JSX.Element {
  return (
    <svg
      className="mark"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="11" width="16" height="6" rx="2" fill="currentColor" opacity="0.28" />
      <rect x="2" y="7" width="16" height="6" rx="2" fill="currentColor" opacity="0.55" />
      <rect x="2" y="3" width="16" height="6" rx="2" fill="currentColor" />
    </svg>
  );
}
