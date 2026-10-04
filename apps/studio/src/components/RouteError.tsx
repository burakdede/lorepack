import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Failure, RouteHeader } from './primitives.js';

/**
 * What a route shows when it throws while rendering.
 *
 * Mounted as each route's `errorElement`, so the failure replaces the route and the sidebar
 * stays: the build id, the other sections and the palette still work. Without it, React
 * Router shows its own developer page in place of the whole app.
 *
 * This does not make a crash acceptable. It makes one reportable: the message is the real
 * error, and the remediation says what to send.
 */
export function RouteError(): React.JSX.Element {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <section>
      <RouteHeader
        title="Something broke"
        intro="This page hit an error it could not recover from. The build and the server are unaffected."
        actions={
          <>
            <a className="action" href="#/">
              Go to Overview
            </a>
            <button type="button" className="action" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
        }
      />
      <Failure
        message={message}
        remediation="Reload the page. If it happens again, open an issue with the steps that led here and the output of `lore doctor --json`."
      />
    </section>
  );
}
