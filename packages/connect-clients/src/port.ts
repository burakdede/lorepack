/**
 * The `ClientConnector` port, architecture 14.8.
 *
 * Every AI client stores its MCP configuration somewhere different, in a shape of its own,
 * with its own trust step. Architecture 24.8 names corrupting one of those files as a real
 * risk, and it is: the file also holds servers a person configured by hand, and a hopeful
 * JSON edit that drops one is a failure they will blame on us and find hours later.
 *
 * So the split is deliberate. **The orchestrator owns safety and the adapter owns knowledge.**
 * An adapter says where the file is and what shape an entry takes; it never decides whether
 * to write, how to back up, or what to tell the user. That way a new client cannot introduce
 * a new way to lose someone's configuration.
 */

/** Whether the client is here at all, and in a version this adapter understands. */
export interface ClientDetection {
  readonly installed: boolean;
  /** The version string the client reports, when it reports one. */
  readonly version?: string;
  /**
   * Whether this adapter is prepared to edit that version's configuration.
   *
   * False degrades to a printed snippet rather than a speculative edit (14.8). Guessing at
   * an unknown shape is exactly how a working configuration becomes a broken one.
   */
  readonly supported: boolean;
  /** Where the configuration lives, for the plan to name. */
  readonly configPath?: string;
  /** Why it is not usable, when it is not. */
  readonly reason?: string;
}

/**
 * Detection plus whether this project is currently wired into that client.
 *
 * Read-only and cheap: Studio's Diagnostics route asks for it, and asking must never write a
 * configuration or spawn a server. `ownedByLorepack` distinguishes an entry this tool created
 * from one a person wrote by hand under the same name, which is the same distinction that
 * makes `lore disconnect` safe.
 */
export interface ClientStatus extends ClientDetection {
  readonly configured: boolean;
  readonly ownedByLorepack: boolean;
}

export type ConnectScope = 'project' | 'user';

export interface ConnectInput {
  readonly projectRoot: string;
  /** The server entry name, so two projects on one machine do not collide. */
  readonly serverName: string;
  /** Executable and arguments, never a concatenated string. */
  readonly command: { readonly executable: string; readonly args: readonly string[] };
  readonly scope: ConnectScope;
}

/**
 * What would change, in full, before anything changes.
 *
 * Architecture 6.6 makes this a step of its own rather than a flag: a plan a user can read
 * is the difference between a tool that edits their configuration and a tool they let edit
 * their configuration.
 */
export interface ConnectPlan {
  readonly clientId: string;
  readonly scope: ConnectScope;
  /** The file that would be written, or null when the client is configured by command. */
  readonly configPath: string | null;
  /** One line per change, in the user's terms, not a diff. */
  readonly changes: readonly string[];
  /** Present when the adapter cannot safely edit and a person must paste something. */
  readonly snippet?: string;
  /** A trust or approval step the client will still require afterwards (6.6 step 11). */
  readonly manualStep?: string;
  /** Carried to `apply`, which must not recompute it: what was shown is what is done. */
  readonly entry: unknown;
  readonly serverName: string;
}

/**
 * Proof of what Lorepack created, so removing it takes back exactly that.
 *
 * The ownership marker is the whole point. Without it `disconnect` has to guess which
 * entries were ours, and the safe guess is "none", which makes it useless, while the useful
 * guess deletes a server someone else configured.
 */
export interface ConnectReceipt {
  readonly clientId: string;
  readonly scope: ConnectScope;
  readonly serverName: string;
  readonly configPath: string | null;
  /** The backup taken before the edit, for the failure that needs undoing by hand. */
  readonly backupPath?: string;
  readonly connectedAt: string;
}

export interface ConnectionCheck {
  readonly ok: boolean;
  /** Which step failed, so a user is not sent looking at the wrong side. */
  readonly step: 'spawn' | 'discover' | 'tools' | 'trust' | 'none';
  readonly detail: string;
  /** The protocol revision the server answered with, when it got that far. */
  readonly protocolVersion?: string;
  /** The client has the entry but has not been trusted yet, which is not a failure. */
  readonly pendingTrust?: boolean;
}

export interface ClientConnector {
  readonly id: string;
  /** Shown in `lore connect --help` and in the plan. */
  readonly title: string;
  detect(): Promise<ClientDetection>;
  /** Detection plus whether this project is already configured. Writes nothing. */
  status(input: ConnectInput): Promise<ClientStatus>;
  plan(input: ConnectInput): Promise<ConnectPlan>;
  apply(plan: ConnectPlan): Promise<ConnectReceipt>;
  verify(receipt: ConnectReceipt): Promise<ConnectionCheck>;
  remove(receipt: ConnectReceipt): Promise<void>;
}
