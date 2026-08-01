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
  readonly contents: string;
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

/** Flips one byte, to prove corruption is detected rather than assumed away. */
export interface CorruptStep extends StepBase {
  readonly action: 'corrupt';
  readonly path: string;
  readonly offset: number;
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
