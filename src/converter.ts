import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import * as ProgressBar from 'progress';
import * as util from 'util';
import * as commander from 'commander';
import * as plist from 'plist';

// @ts-ignore
import { Splitter, Joiner, Rewriter } from 'mailsplit';
import { Transform, TransformCallback, pipeline, Writable } from 'stream';
import * as Debug from 'debug';

const debug = Debug('converter');

class DeletedMessageError extends Error {
  constructor(...args: string[] | undefined[]) {
    super(...args);
    this.name = 'DeletedMessageError';
  }
}

export async function processEmlxs(
  inputDir: string,
  outputDir: string,
  ignoreErrors?: boolean,
  skipDeleted?: boolean
): Promise<void> {
  const files = await util.promisify(glob)('**/*.emlx', { cwd: inputDir });
  const bar = new ProgressBar('Converting [:bar] :percent :etas :file', { total: files.length, width: 40 });
  for (const file of files) {
    bar.tick({ file });
    const resultPath = path.join(outputDir, `${stripExtension(path.basename(file))}.eml`);
    try {
      const writeStream = fs.createWriteStream(resultPath);
      const messages = await processEmlx(path.join(inputDir, file), writeStream, ignoreErrors, skipDeleted);
      messages.forEach(message => bar.interrupt(`${file}: ${message}`));
    } catch (e) {
      if (e instanceof DeletedMessageError && e.message == 'DELETED') {
        bar.interrupt(`${file}: Message is marked as deleted (skipped)`);
        continue;
      }
      bar.interrupt(
        `Encountered error when processing ${file} -- run with '--ignoreErrors' argument to avoid aborting the conversion.`
      );
      bar.terminate();
      throw e;
    }
  }
}

// 'X-Apple-Content-Length' denotes an external attachment in case of .partial.emlx
const appleContentLengthHeader = 'X-Apple-Content-Length';

/**
 * Process a single .emlx or .partial.emlx file.
 *
 * @param emlxFile Path to the file.
 * @param resultStream The stream to which to write the result.
 * @param ignoreErrors `true` to suppress throwing errors
 * (e.g. when attachment is missing). In this case, the
 * result array will contain a list of errors.
 * @returns List of error messages (when `ignoreErrors` was enabled)
 */
export async function processEmlx(
  emlxFile: string,
  resultStream: Writable,
  ignoreErrors = false,
  skipDeleted = false
): Promise<string[]> {
  const messages: string[] = [];
  // see here for a an example how to implement the Rewriter:
  // https://github.com/andris9/mailsplit/blob/master/examples/rewrite-html.js

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rewriter = new Rewriter((node: any) => node.headers.hasHeader(appleContentLengthHeader));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rewriter.on('node', (data: any) => {
    data.node.headers.remove(appleContentLengthHeader);
    data.decoder.on('data', () => {
      // no op (callback needs to be here though!)
    });
    data.decoder.on('end', () => {
      integrateAttachment(emlxFile, data).catch(err => {
        // propagate error event
        if (ignoreErrors) {
          // just store in `messages`
          messages.push(err.message);
        } else {
          // emit (and then throw)
          rewriter.emit('error', err);
        }
      });
    });
  });
  await util.promisify(pipeline)(
    fs.createReadStream(emlxFile),
    new SkipEmlxTransform(skipDeleted),
    new Splitter(),
    rewriter,
    new Joiner(),
    resultStream
  );
  return messages;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function integrateAttachment(emlxFile: string, data: any): Promise<void> {
  const attachmentDirectoryPath = path.join(
    path.dirname(emlxFile),
    '..',
    'Attachments',
    stripExtension(path.basename(emlxFile)),
    data.node.partNr.join('.') // e.g. array [1, 1, 2]
  );
  // first try to get the name as explicitly specified in the email text
  // (this seems like the most reliable way), but if that does not work,
  // check the `Attachments` directory structure. See:
  // https://github.com/qqilihq/partial-emlx-converter/issues/3
  const fileNames = [data.node.filename, await getFilenameFromFileSystem(attachmentDirectoryPath)].filter(
    (f): f is string => !!f
  );
  let processedAttachment = false;
  for (const fileName of fileNames) {
    const filePath = path.join(attachmentDirectoryPath, fileName);
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('error', error => reject(error));
        stream.on('close', () => resolve());
        stream.pipe(data.encoder);
      });
      processedAttachment = true;
      break;
    } catch (e) {
      // ignore here, keep trying
    }
  }
  if (!processedAttachment) {
    data.encoder.end();
    let message = 'Could not get attachment file';
    if (fileNames.length > 0) {
      message += ` (tried ${fileNames.join(', ')})`;
    }
    throw new Error(message);
  }
}

/**
 * In case we cannot extract the attachment filename from the
 * email, we detrmine it by looking into the file system. We
 * expect, that the corresponding attachment directory
 * (e.g. `1.2`) contains exactly *one* file (ignoring `.DS_Store`).
 *
 * This is necessary, because Mail.app uses a language-specific
 * default name for attachments without explicitly given
 * file name (e.g. 'Mail-Anhang.jpeg' on a German system).
 *
 * @param pathToDirectory Path to the attachment directory (e.g. `.../1.2`)
 * @returns The filname, or `null` in case it could not be determined.
 */
async function getFilenameFromFileSystem(pathToDirectory: string): Promise<string | null> {
  try {
    // ignore `.DS_Store`
    const files = (await fs.promises.readdir(pathToDirectory)).filter(file => !file.startsWith('.DS_Store'));
    if (files.length !== 1) {
      const filenames = files.length > 0 ? `(${files.join(', ')})` : '';
      debug(
        `Couldn’t determine attachment; expected '${pathToDirectory}' ` +
          `to contain one file, but there were: ${files.length} ${filenames}`
      );
      return null;
    } else {
      return files[0];
    }
  } catch (e) {
    debug(`Couldn’t read attachments in '${pathToDirectory}'`);
    return null;
  }
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\..*/, '');
}

export const EmlxFlagNames = [
  'read', // 0
  'deleted',
  'answered',
  'encrypted',
  'flagged',
  'recent',
  'draft',
  'initial',
  'forwarded',
  'redirected', // 9
  'signed', // 23
  'junk',
  'notJunk'
] as const;

export type EmlxFlags = typeof EmlxFlagNames[number];

// emlx file contain the length of the 'payload' in the first line;
// this allows to strip away the plist epilogue at the end of the
// files easily
export class SkipEmlxTransform extends Transform {
  private bytesToRead: number | undefined = undefined;
  private bytesRead = 0;
  private skipDeleted: boolean;
  private plistChunks: Buffer[] = [];

  constructor(skipDeleted: boolean) {
    super();
    this.skipDeleted = skipDeleted;
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    let offset: number;
    let length: number;
    if (!this.bytesToRead) {
      const payloadLengthMatch = /^(\d+)\s+/.exec(chunk.toString('utf8'));
      if (!payloadLengthMatch) {
        // XXX first chunk could theoretically be smaller,
        // then we’d need to buffer the chunks until the
        // first linebreak -- seems unlikely though.
        return callback(new Error('Invalid structure; content did not start with payload length'));
      }
      this.bytesToRead = parseInt(payloadLengthMatch[1], 10);
      offset = payloadLengthMatch[0].length;
      length = Math.min(this.bytesToRead + offset, chunk.length);
    } else {
      offset = 0;
      length = Math.min(this.bytesToRead - this.bytesRead, chunk.length);
    }
    let slicedChunk = chunk.slice(offset, length);
    this.bytesRead += slicedChunk.length;
    if (this.bytesRead === this.bytesToRead) {
      // fix for #5 -- an end boundary string which is only terminated
      // with a single '-' is corrected to double '--' here
      const temp = slicedChunk.toString('utf8');
      if (temp.endsWith('-') && !temp.endsWith('--')) {
        const nextChars = chunk.slice(length, length + 5).toString('utf8');
        if (nextChars === '<?xml') {
          slicedChunk = Buffer.concat([slicedChunk, Buffer.from('-')]);
        }
      }
      this.plistChunks.push(chunk.slice(length, chunk.length));
    }
    callback(undefined, slicedChunk);
  }

  _flush(callback: TransformCallback): void {
    // we parse & process the trailing plist data from the emlx file
    const plistDict = Buffer.concat(this.plistChunks).toString('utf8');
    const plData = plist.parse(plistDict) as plist.PlistObject;

    // the flags are documented here: https://docs.fileformat.com/email/emlx/
    const flags = plData['flags'] as number;
    const flagNames: EmlxFlags[] = [];
    let flagBit = 0;
    for (const flagName of EmlxFlagNames) {
      const mask = 1 << flagBit;
      if (flags & mask) {
        flagNames.push(flagName);
      }
      if (flagBit == 9) {
        // flags jump from bit 9 to bit 23 (10-15: attachment count; 16-22: prio)
        flagBit = 23;
      } else {
        flagBit++;
      }
    }

    // skip deleted messages
    if (this.skipDeleted && flagNames.includes('deleted')) {
      callback(new DeletedMessageError('DELETED'));
    } else {
      callback();
    }
  }
}

export function processCli(): void {
  const program = new commander.Command();
  program.name('partial-emlx-converter').description('Read .emlx files and convert them to .elm files');

  program
    .command('convert', { isDefault: true })
    .description('convert .emlx-files from input folder to .eml files in output folder')
    .option('--ignoreErrors', "Don't abort the conversion on error (see the log output for details in this case)")
    .option('--skipDeleted', 'Skip messages marked as deleted')
    .argument('<input_directory>', 'input folder to read .emlx-files from')
    .argument('<output_directory>', 'output folder for .eml-files')
    .action((inputDir: string, outputDir: string, options: { ignoreErrors?: boolean; skipDeleted?: boolean }) => {
      processEmlxs(inputDir, outputDir, options.ignoreErrors, options.skipDeleted).catch(err => console.error(err));
    });

  program.parse(process.argv);
}
