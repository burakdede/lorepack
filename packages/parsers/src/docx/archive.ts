import { LoreError } from '@lorepack/core';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { ZIP_LIMITS } from '../xlsx/zip.js';

export const DOCX_ARCHIVE_LIMITS = {
  maxPartBytes: 80 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
  maxParts: ZIP_LIMITS.maxParts,
} as const;

export async function checkDocxArchive(bytes: Uint8Array, displayPath: string): Promise<void> {
  const zip = await openArchive(bytes, displayPath);
  try {
    await checkEntries(zip, displayPath);
  } finally {
    zip.close();
  }
}

function openArchive(bytes: Uint8Array, displayPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, validateEntrySizes: true },
      (cause, zip) => {
        if (cause !== null || zip === undefined) {
          reject(
            new LoreError(
              'LORE_E_UNSUPPORTED_FORMAT',
              `${displayPath} is not a readable .docx archive.`,
              {
                remediation:
                  'It may be corrupt, or password-protected, which Lorepack never prompts for. Open it to confirm, remove any password, or exclude it in .loreignore.',
                path: displayPath,
                ...(cause === null ? {} : { cause }),
              },
            ),
          );
          return;
        }
        resolve(zip);
      },
    );
  });
}

function checkEntries(zip: ZipFile, displayPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const names = new Set<string>();
    let declaredTotal = 0;
    let streamedTotal = 0;
    let settled = false;

    const fail = (error: LoreError): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    const exceeds = (): LoreError =>
      new LoreError(
        'LORE_E_ENVELOPE_EXCEEDED',
        `${displayPath} expands to more data than Lorepack will read.`,
        {
          remediation:
            'This DOCX archive exceeds its byte or part limit. Check that it is a normal Word document, or split it into smaller documents.',
          path: displayPath,
        },
      );
    const unreadable = (cause: Error): LoreError =>
      new LoreError('LORE_E_PARSE_FAILED', `${displayPath} has an unreadable archive part.`, {
        remediation: 'Open and re-save the document in Word, or exclude it in .loreignore.',
        path: displayPath,
        cause,
      });

    zip.on('entry', (entry: Entry) => {
      if (settled) return;
      if (names.has(entry.fileName)) {
        fail(
          new LoreError(
            'LORE_E_UNSUPPORTED_FORMAT',
            `${displayPath} contains duplicate package part ${entry.fileName}.`,
            {
              remediation: 'The DOCX package is ambiguous. Open and re-save it in Word.',
              path: displayPath,
            },
          ),
        );
        return;
      }
      names.add(entry.fileName);
      declaredTotal += entry.uncompressedSize;
      if (
        names.size > DOCX_ARCHIVE_LIMITS.maxParts ||
        entry.uncompressedSize > DOCX_ARCHIVE_LIMITS.maxPartBytes ||
        declaredTotal > DOCX_ARCHIVE_LIMITS.maxTotalBytes
      ) {
        fail(exceeds());
        return;
      }

      zip.openReadStream(entry, (cause, stream) => {
        if (settled) return;
        if (cause !== null || stream === undefined) {
          fail(unreadable(cause ?? new Error(`Could not open ${entry.fileName}.`)));
          return;
        }
        let partBytes = 0;
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          partBytes += chunk.byteLength;
          streamedTotal += chunk.byteLength;
          if (
            partBytes > DOCX_ARCHIVE_LIMITS.maxPartBytes ||
            streamedTotal > DOCX_ARCHIVE_LIMITS.maxTotalBytes
          ) {
            fail(exceeds());
            stream.destroy();
          }
        });
        stream.on('error', (cause: Error) => fail(unreadable(cause)));
        stream.on('end', () => {
          if (!settled) zip.readEntry();
        });
      });
    });
    zip.on('error', (cause: Error) => fail(unreadable(cause)));
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.readEntry();
  });
}
