import { useId, useState } from 'react';
import { type Equivalents as Forms, formatMcp } from '../lib/equivalents.js';
import './Equivalents.css';

/**
 * "Use it anywhere": the request Studio just made, as a CLI command, an HTTP call and an MCP
 * tool call. The point is that nothing tried here has to be retyped to be used elsewhere.
 *
 * Tabs rather than three stacked blocks, because a developer wants one of them at a time and
 * three code blocks would push the answer they asked for off the screen.
 */

type Form = 'cli' | 'http' | 'mcp';

const LABELS: Record<Form, string> = { cli: 'CLI', http: 'HTTP', mcp: 'MCP' };

const NOTES: Record<Form, string> = {
  cli: 'Run in the project directory.',
  http: 'The same request against this running server.',
  mcp: 'The tools/call params an MCP client sends to this server.',
};

export function Equivalents({
  forms,
  label = 'Use it anywhere',
}: {
  readonly forms: Forms;
  readonly label?: string;
}): React.JSX.Element {
  const available: Form[] = forms.cli === undefined ? ['http', 'mcp'] : ['cli', 'http', 'mcp'];
  const [chosen, setChosen] = useState<Form>(available[0] ?? 'http');
  const form = available.includes(chosen) ? chosen : (available[0] ?? 'http');
  const [copied, setCopied] = useState(false);
  const id = useId();

  const text =
    form === 'cli' ? (forms.cli ?? '') : form === 'http' ? forms.http : formatMcp(forms.mcp);

  return (
    <section className="equivalents" aria-label={label}>
      <div className="equivalents-head">
        <h3 className="equivalents-title">{label}</h3>
        <div className="equivalents-tabs" role="tablist" aria-label={`${label} as`}>
          {available.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              id={`${id}-${option}`}
              aria-selected={option === form}
              aria-controls={`${id}-panel`}
              className={option === form ? 'equivalents-tab equivalents-tab-on' : 'equivalents-tab'}
              onClick={() => {
                setChosen(option);
                setCopied(false);
              }}
            >
              {LABELS[option]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="action action-small equivalents-copy"
          aria-label={`Copy the ${LABELS[form]} form`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${form}`}>
        {/* Focusable, because a long command scrolls sideways and a keyboard has to reach it. */}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus */}
        <pre className="equivalents-code" tabIndex={0}>
          <code>{text}</code>
        </pre>
        <p className="equivalents-note">
          {form === 'mcp' ? (
            <>
              {'Tool '}
              <code>{forms.mcp.name}</code>
              {'. '}
              {NOTES.mcp}
            </>
          ) : (
            NOTES[form]
          )}
        </p>
      </div>
    </section>
  );
}
