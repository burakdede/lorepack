import { LoreError } from '@lorepack/core';
import sax from 'sax';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

/**
 * The container half of the XLSX reader: a ZIP of XML parts, opened defensively.
 *
 * An `.xlsx` is untrusted binary input, and every hardening decision here is ours to make
 * rather than a library's to have made correctly. Architecture section 20.9 asks for exactly
 * that, and the ADR treats it as a gain rather than a cost.
 */

/**
 * Caps, applied while reading rather than after.
 *
 * A cap checked after decompression is not a cap: the memory is already spent. Each of these
 * is enforced against a running total as bytes arrive, so a zip bomb fails at the threshold
 * instead of at the point where it would have exhausted the process.
 */
export const ZIP_LIMITS = {
  /** Total decompressed bytes across every part read. 40x a 64 MB workbook. */
  maxTotalBytes: 2_048 * 1024 * 1024,
  /** One part. A sheet is the big one; the others are small by construction. */
  maxPartBytes: 1_024 * 1024 * 1024,
  /** Parts opened. A real workbook has one per sheet plus a handful. */
  maxParts: 512,
} as const;

export interface Package {
  readonly entries: ReadonlyMap<string, Entry>;
  /** Streams one part through `sax`, never buffering the document. */
  readXml(name: string, handlers: XmlHandlers): Promise<void>;
  close(): void;
}

export interface XmlHandlers {
  readonly open?: (name: string, attributes: Record<string, string>) => void;
  readonly text?: (text: string) => void;
  readonly close?: (name: string) => void;
}

export async function openPackage(bytes: Uint8Array, displayPath: string): Promise<Package> {
  const zip = await fromBuffer(bytes, displayPath);
  const entries = await listEntries(zip, displayPath);
  let totalBytes = 0;

  return {
    entries,
    async readXml(name, handlers): Promise<void> {
      const entry = entries.get(name);
      if (entry === undefined) return;
      totalBytes = await streamXml(zip, entry, handlers, totalBytes, displayPath);
    },
    close(): void {
      zip.close();
    },
  };
}

function fromBuffer(bytes: Uint8Array, displayPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true },
      (error, zip) => {
        if (error !== null || zip === undefined) {
          // A password-protected workbook is an OLE container rather than a ZIP, so it fails
          // here with a message about a central directory. Naming the likely cause beats
          // passing that through, and stating that Lorepack never prompts closes the loop
          // for someone who would otherwise go looking for the prompt.
          reject(
            new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} is not a readable .xlsx.`, {
              remediation:
                'It may be corrupt, or password-protected, which Lorepack never prompts for. Open it to confirm, remove any password, or exclude it in .loreignore.',
              path: displayPath,
              ...(error === null ? {} : { cause: error }),
            }),
          );
          return;
        }
        resolve(zip);
      },
    );
  });
}

function listEntries(zip: ZipFile, displayPath: string): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, Entry>();
    zip.on('entry', (entry: Entry) => {
      if (found.size >= ZIP_LIMITS.maxParts) {
        reject(
          new LoreError('LORE_E_ENVELOPE_EXCEEDED', `${displayPath} contains too many parts.`, {
            remediation: `A workbook with more than ${String(ZIP_LIMITS.maxParts)} internal parts is not something Excel produces. Check the file is what you think it is.`,
            path: displayPath,
          }),
        );
        return;
      }
      // Entry names are used only as map keys and compared against fixed strings. They are
      // never joined onto a filesystem path, so a `../../` name is inert rather than a
      // traversal: nothing here writes a file.
      found.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(found));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/**
 * One part, streamed through `sax`, with a decompressed-byte budget.
 *
 * `sax` in strict mode does **not** expand custom entities: verified against an XXE payload
 * and a billion-laughs payload, both of which yield a parse error and the literal `&x;`
 * rather than a file read or a gigabyte of As. The DOCTYPE refusal below is therefore belt
 * and braces rather than the only defence, and it stays because the guarantee we depend on
 * should be one we assert rather than one we inherit.
 */
function streamXml(
  zip: ZipFile,
  entry: Entry,
  handlers: XmlHandlers,
  totalBefore: number,
  displayPath: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, source) => {
      if (error !== null || source === undefined) {
        reject(
          new LoreError(
            'LORE_E_PARSE_FAILED',
            `${displayPath} could not be read: ${entry.fileName} is unreadable.`,
            {
              remediation: 'The workbook may be corrupt. Open it in Excel to confirm.',
              path: displayPath,
              ...(error === null ? {} : { cause: error }),
            },
          ),
        );
        return;
      }

      // Driven by hand rather than with `source.pipe(parser)`.
      //
      // `sax`'s stream is an old-style stream with no `destroy`, and Node's pipe calls
      // `dest.destroy()` on its error and backpressure paths. On a small part nothing
      // triggers it; at the 500,000-row envelope the sheet stream hits backpressure and the
      // whole read dies with `TypeError: dest.destroy is not a function`, reported as a
      // corrupt workbook. Writing chunks in explicitly avoids the assumption entirely and
      // puts the byte budget in the same place as the write, which is where it belongs.
      // `sax` parses synchronously, so there is no buffer to grow between chunks.
      const parser = sax.parser(true, { trim: false, position: false });
      let partBytes = 0;
      let total = totalBefore;
      let failed = false;

      const fail = (problem: LoreError): void => {
        if (failed) return;
        failed = true;
        source.destroy();
        reject(problem);
      };

      parser.ondoctype = (): void => {
        fail(
          new LoreError(
            'LORE_E_UNSUPPORTED_FORMAT',
            `${displayPath} declares a document type inside ${entry.fileName}.`,
            {
              remediation:
                'Spreadsheet parts have no legitimate reason to declare one, and it is the shape of an entity-expansion attack, so Lorepack refuses the file rather than reading it carefully.',
              path: displayPath,
            },
          ),
        );
      };

      if (handlers.open !== undefined) {
        const open = handlers.open;
        parser.onopentag = (node): void => {
          open(node.name, node.attributes as Record<string, string>);
        };
      }
      if (handlers.text !== undefined) {
        const text = handlers.text;
        // Text arrives in pieces, because a stream splits a long shared string across reads
        // and `sax` reports each piece as it sees it. Every caller accumulates.
        parser.ontext = (value): void => {
          text(value);
        };
        parser.oncdata = (value): void => {
          text(value);
        };
      }
      if (handlers.close !== undefined) {
        const close = handlers.close;
        parser.onclosetag = (name): void => {
          close(name);
        };
      }
      parser.onerror = (cause): void => {
        fail(
          new LoreError(
            'LORE_E_PARSE_FAILED',
            `${displayPath} contains malformed XML in ${entry.fileName}.`,
            {
              remediation: 'The workbook is damaged. Open and re-save it in Excel, or exclude it.',
              path: displayPath,
              cause,
            },
          ),
        );
      };

      source.on('data', (chunk: Buffer) => {
        if (failed) return;
        partBytes += chunk.byteLength;
        total += chunk.byteLength;
        if (partBytes > ZIP_LIMITS.maxPartBytes || total > ZIP_LIMITS.maxTotalBytes) {
          fail(
            new LoreError(
              'LORE_E_ENVELOPE_EXCEEDED',
              `${displayPath} expands to more data than Lorepack will read.`,
              {
                remediation:
                  'A file this small that decompresses this large is usually a zip bomb rather than a spreadsheet. If it is genuinely this big, split it.',
                path: displayPath,
              },
            ),
          );
          return;
        }
        try {
          parser.write(chunk.toString('utf8'));
        } catch (cause) {
          // A handler throwing (an envelope limit inside `streamSheet`, for instance) must
          // surface as itself rather than as "malformed XML".
          fail(
            cause instanceof LoreError
              ? cause
              : new LoreError('LORE_E_PARSE_FAILED', `${displayPath} could not be read.`, {
                  remediation: 'The workbook may be damaged. Open it in Excel to confirm.',
                  path: displayPath,
                  cause: cause instanceof Error ? cause : new Error(String(cause)),
                }),
          );
        }
      });
      source.on('end', () => {
        if (failed) return;
        try {
          parser.close();
        } catch (cause) {
          fail(
            cause instanceof LoreError
              ? cause
              : new LoreError(
                  'LORE_E_PARSE_FAILED',
                  `${displayPath} contains malformed XML in ${entry.fileName}.`,
                  {
                    remediation:
                      'The workbook is damaged. Open and re-save it in Excel, or exclude it.',
                    path: displayPath,
                    cause: cause instanceof Error ? cause : new Error(String(cause)),
                  },
                ),
          );
          return;
        }
        if (!failed) resolve(total);
      });
      source.on('error', (cause: Error) => {
        fail(
          new LoreError('LORE_E_PARSE_FAILED', `${displayPath} could not be decompressed.`, {
            remediation: 'The workbook may be corrupt. Open it in Excel to confirm.',
            path: displayPath,
            cause,
          }),
        );
      });
    });
  });
}
