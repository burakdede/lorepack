/**
 * The acceptance catalogue, as data.
 *
 * Every scenario is one thing a person does with the `lore` binary, written as steps a
 * runner executes and a renderer describes. Keeping it data rather than a test file per
 * behaviour buys three things: the executed suite and the written checklist come from one
 * source and cannot drift, a scenario that no machine can run still has a home, and adding
 * a command in a later phase means adding rows rather than inventing a shape.
 */

/** Node's `process.platform` values this project runs on. */
export type Platform = 'darwin' | 'linux' | 'win32';

export interface Scenario {
  /** Stable identifier, `area/behaviour`. Phase gates and CI output cite this. */
  readonly id: string;
  readonly title: string;
  /**
   * The guarantee this proves, in the words of the invariant or architecture section it
   * comes from. A failing scenario should read as a broken promise, not a broken assertion.
   */
  readonly proves: string;
  /**
   * `manual` scenarios are rendered into the checklist and never executed. They exist
   * because a real TTY, a client trust prompt and a fresh machine cannot be automated, and
   * leaving them out of the catalogue would make them invisible rather than manual.
   */
  readonly mode: 'auto' | 'manual';
  /** Issue this scenario locks down, when it exists to stop a specific defect returning. */
  readonly regression?: number;
  readonly fixture: Fixture;
  readonly steps: readonly Step[];
  /**
   * Runs against the packages as published rather than as checked out: only the files each
   * package declares, assembled into a `node_modules` tree outside the repository.
   *
   * Worth its own mode because #164 was invisible to every other scenario. A working tree
   * contains files the package does not ship, so a build asset that is never published still
   * resolves, and the suite proves the product works in the one layout no user has.
   */
  readonly runFrom?: 'installed';
  /**
   * Section 7 of the working agreement: a test skipped on a platform needs a written
   * reason, so the reason is required by the type rather than by review.
   */
  readonly skip?: { readonly platforms: readonly Platform[]; readonly reason: string };
}

export interface Fixture {
  /** Inline sources, keyed by POSIX-style relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * A generated corpus, for the scenarios that only mean anything at scale: the envelope
   * guard, visible progress, and cancelling work that is actually in flight.
   */
  readonly generated?: {
    readonly documents: number;
    readonly sectionsPerDocument: number;
  };
  /**
   * A realistic mixed folder: one file of every supported format, including the binary ones.
   *
   * Milestone 2's exit criterion (section 21) is about a *mixed* project, and every format
   * except Markdown and text arrives as bytes rather than as a string, so it cannot be
   * expressed with `files`. Generated rather than committed, because a repository full of
   * binary fixtures is one nobody can review in a diff.
   */
  readonly mixed?: boolean;
  /** Commands run before the steps, so a scenario states only what it is about. */
  readonly setup?: readonly SetupStep[];
}

export type SetupStep = 'init' | 'build' | 'build-large';

/**
 * What a step does. A closed set rather than arbitrary callbacks: each action has one
 * execution and one human sentence, which is what lets the same list drive the suite and
 * the checklist.
 */
export type Step =
  | RunStep
  | RunInStep
  | WriteStep
  | EmptySourcesStep
  | SymlinkStep
  | CloneStep
  | CorruptStep
  | ExternalStep
  | InterruptStep
  | ConcurrentStep
  | IdenticalStep
  | RecordStep
  | UnchangedStep
  | ProtocolStep
  | NoteStep;

interface StepBase {
  /** Overrides the generated sentence in the checklist when the default reads poorly. */
  readonly describe?: string;
}

/** Runs the real binary against the scenario's project. */
export interface RunStep extends StepBase {
  readonly action: 'run';
  readonly args: readonly string[];
  /** Adds `--json`, which is required for `expect.json` and for capturing values. */
  readonly json?: boolean;
  readonly expect?: Expect;
  /** Values pulled out of the JSON result for later steps, keyed by placeholder name. */
  readonly capture?: Readonly<Record<string, string>>;
}

/** Runs the binary against a project made earlier by a `clone` step. */
export interface RunInStep extends StepBase {
  readonly action: 'run-in';
  readonly project: string;
  readonly args: readonly string[];
  readonly json?: boolean;
  readonly expect?: Expect;
  readonly capture?: Readonly<Record<string, string>>;
}

export interface WriteStep extends StepBase {
  readonly action: 'write';
  readonly path: string;
  /** Ignored when `bytes` is given. */
  readonly contents: string;
  /**
   * Exact bytes, for the files that cannot be written as text: a NUL byte, a UTF-16 byte
   * order mark, a sequence that is not valid UTF-8. Writing them as a string would encode
   * them into something valid and test nothing.
   */
  readonly bytes?: readonly number[];
  /**
   * Writes a sibling file and renames over the target, which is how editors actually save.
   * On Windows that is the case naive file handling gets wrong, so simulating it is the
   * difference between a suite that passes and a suite that is honest.
   */
  readonly atomic?: boolean;
}

/**
 * Empties every source file without deleting it. Proving that a command still answers
 * afterwards is stronger than counting parse work, which an accidental cache hit satisfies.
 */
export interface EmptySourcesStep extends StepBase {
  readonly action: 'empty-sources';
}

export interface SymlinkStep extends StepBase {
  readonly action: 'symlink';
  readonly path: string;
  /** The link target, created outside the project root with the given contents. */
  readonly outsideFile: { readonly name: string; readonly contents: string };
}

/** Copies sources and configuration to a second absolute path, for determinism. */
export interface CloneStep extends StepBase {
  readonly action: 'clone';
  readonly as: string;
}

/**
 * Flips one byte, to prove corruption is detected rather than assumed away.
 *
 * `member` names a ZIP member and makes `offset` relative to that member's stored data.
 * Prefer it over a bare file offset whenever the target is an archive. An absolute offset
 * silently follows the layout: #234 lengthened `manifest.json` by five lines, which pushed
 * byte 1200 out of the payload and into `checksums.json`, so the scenario went on failing
 * for a different reason than the one it was written to prove.
 */
export interface CorruptStep extends StepBase {
  readonly action: 'corrupt';
  readonly path: string;
  readonly offset: number;
  readonly member?: string;
}

/**
 * Runs a tool that is not ours, to check interoperability claims. Optional by default:
 * Windows runners have no `unzip`, and a missing third-party tool is not a product defect.
 */
export interface ExternalStep extends StepBase {
  readonly action: 'external';
  readonly command: string;
  readonly args: readonly string[];
  readonly expect?: Expect;
  readonly whenMissing: 'skip' | 'fail';
}

/**
 * Starts the binary, waits, sends a real signal, and asserts what happened.
 *
 * Spawning and signalling for real is not an implementation detail of this step: an
 * in-process `AbortSignal` is what let #146 through, because it proves the checkpoints
 * honour an aborted signal and never proves the signal arrives.
 */
export interface InterruptStep extends StepBase {
  readonly action: 'interrupt';
  readonly args: readonly string[];
  readonly signal: 'SIGINT' | 'SIGTERM';
  /**
   * Waits for this pattern in the output before signalling, so the interrupt lands in the
   * stage under test rather than wherever a fixed delay happens to fall.
   *
   * A delay cannot do this job. On a fast runner 250 ms arrives before the process has
   * finished starting, and the signal kills a program that has not installed its handler
   * yet: the scenario then fails claiming cancellation is broken when nothing was ever
   * cancelled. Waiting for the stage to announce itself is the only version that means the
   * same thing on every machine.
   */
  readonly afterOutput?: string;
  /** Settling delay after the pattern appears, or the whole delay when there is no pattern. */
  readonly afterMs: number;
  /** Sends the signal twice, to check the documented "second interrupt exits now". */
  readonly repeat?: number;
  /**
   * Changes a source file after the command is running and before it is signalled.
   *
   * The only way to reach a supervisor that reacts to the filesystem. `write` before the
   * command cannot do it: what is under test is a change arriving while the process is up
   * and watching, which is a different code path from a change that was already there.
   */
  readonly writeWhileRunning?: { readonly path: string; readonly contents: string };
  readonly expect?: Expect;
}

/**
 * Runs a second command while the first is still working, which is the only way to reach
 * the project lock. Section 4.3 forbids a command that appears to hang, so the interesting
 * assertion is on what the waiting command says, not on which one finishes first.
 */
export interface ConcurrentStep extends StepBase {
  readonly action: 'concurrent';
  readonly background: readonly string[];
  readonly foreground: readonly string[];
  /** Delay before the second command starts, so the first is past its own startup. */
  readonly afterMs: number;
  readonly expect?: Expect;
  /** Environment for both commands, for a knob that has no flag. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Compares a file in two projects.
 *
 * Determinism is not only the build id: an identical id with a differing manifest would
 * mean the record describing the build is not itself reproducible. The archive is the same
 * promise made portable, and on one machine it has to match byte for byte.
 */
export interface IdenticalStep extends StepBase {
  readonly action: 'identical';
  readonly left: FileRef;
  readonly right: FileRef;
  /** `json` compares parsed values, so key order in the file is not part of the claim. */
  readonly as: 'bytes' | 'json';
}

export interface FileRef {
  /** A project created by a `clone` step. Omitted means the scenario's own project. */
  readonly project?: string;
  readonly path: string;
}

/** Snapshots `builds/` and the active pointer under a name. */
export interface RecordStep extends StepBase {
  readonly action: 'record';
  readonly name: string;
}

/** Asserts a snapshot still holds, which is the immutability guarantee in one line. */
export interface UnchangedStep extends StepBase {
  readonly action: 'unchanged';
  readonly name: string;
}

/**
 * Speaks the MCP protocol to the binary over stdio.
 *
 * A new step kind rather than a new suite, which is what the Phase 2 audit asked for. What
 * it proves cannot be reached any other way: that a client's first frame is answered, and
 * that stdout carried protocol and nothing else while a build was reporting progress.
 */
export interface ProtocolStep extends StepBase {
  readonly action: 'protocol';
  /** Arguments after `lore`, for example `['mcp', '--ensure-current']`. */
  readonly args: readonly string[];
  /** The JSON-RPC method to call once the process is up. */
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Substrings the serialized response must contain. */
  readonly expectResult?: readonly string[];
  /** Substrings stderr must contain, which is where every diagnostic belongs. */
  readonly expectStderr?: readonly string[];
}

/** A human instruction. Only valid in a manual scenario. */
export interface NoteStep extends StepBase {
  readonly action: 'note';
  readonly text: string;
  readonly expect: string;
}

export interface Expect {
  readonly exitCode?: number;
  readonly stdout?: TextExpect;
  readonly stderr?: TextExpect;
  /** Asserts stdout parses as JSON on its own, which is the `--json` output contract. */
  readonly stdoutIsJson?: boolean;
  readonly json?: readonly JsonExpect[];
  /** Shorthand for a `LORE_E_*` code appearing in the rendered error. */
  readonly errorCode?: string;
}

export interface TextExpect {
  readonly contains?: readonly string[];
  readonly excludes?: readonly string[];
  /** Regular expression sources, tested against the whole stream. */
  readonly matches?: readonly string[];
  /**
   * How often a pattern appears. Progress is the case that needs it: one line proves the
   * stage started, and only repetition proves the user can tell work from a hang.
   */
  readonly occurrences?: readonly { readonly pattern: string; readonly atLeast: number }[];
  readonly empty?: boolean;
}

export interface JsonExpect {
  /** Dot path with array indexes, for example `builds[0].buildId`. */
  readonly path: string;
  readonly equals?: unknown;
  readonly matches?: string;
  readonly exists?: boolean;
  readonly atLeast?: number;
  readonly equalsCapture?: string;
  readonly differsFromCapture?: string;
}
