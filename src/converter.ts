import fs from 'node:fs';
// @deno-types="npm:@types/glob@7.2.0"
import glob from 'npm:glob@7.2.0';
import path from 'node:path';
// @deno-types="npm:@types/progress@^2.0.5"
import ProgressBar from 'npm:progress@2.0.3';
import util from 'node:util';
// @ts-ignore - no typings available
import { Joiner, Rewriter, Splitter } from 'npm:mailsplit@5.4.0';
import { pipeline, Transform, TransformCallback, Writable } from 'node:stream';
// @deno-types="npm:@types/debug@4.1.7"
import Debug from 'npm:debug@4.3.3';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const debug = Debug('converter');

export async function processEmlxs(inputDir: string, outputDir: string, ignoreErrors?: boolean): Promise<void> {
  const files = await util.promisify(glob)('**/*.emlx', { cwd: inputDir });
  const bar = new ProgressBar('Converting [:bar] :percent :etas :file', { total: files.length, width: 40 });
  for (const file of files) {
    bar.tick({ file });
    try {
      const resultPath = path.join(outputDir, `${stripExtension(path.basename(file))}.eml`);
      const writeStream = fs.createWriteStream(resultPath);
      const messages = await processEmlx(path.join(inputDir, file), writeStream, ignoreErrors);
      messages.forEach((message) => bar.interrupt(`${file}: ${message}`));
    } catch (e) {
      bar.interrupt(
        `Encountered error when processing ${file} -- run with '--ignoreErrors' argument to avoid aborting the conversion.`,
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
export async function processEmlx(emlxFile: string, resultStream: Writable, ignoreErrors = false): Promise<string[]> {
  const messages: string[] = [];
  // see here for a an example how to implement the Rewriter:
  // https://github.com/andris9/mailsplit/blob/master/examples/rewrite-html.js

  // deno-lint-ignore no-explicit-any
  const rewriter = new Rewriter((node: any) => node.headers.hasHeader(appleContentLengthHeader));
  // deno-lint-ignore no-explicit-any
  rewriter.on('node', (data: any) => {
    data.node.headers.remove(appleContentLengthHeader);
    data.decoder.on('data', () => {
      // no op (callback needs to be here though!)
    });
    data.decoder.on('end', () => {
      integrateAttachment(emlxFile, data).catch((err) => {
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
    new SkipEmlxTransform(),
    new Splitter(),
    rewriter,
    new Joiner(),
    resultStream,
  );
  return messages;
}

// deno-lint-ignore no-explicit-any
async function integrateAttachment(emlxFile: string, data: any): Promise<void> {
  const attachmentDirectoryPath = path.join(
    path.dirname(emlxFile),
    '..',
    'Attachments',
    stripExtension(path.basename(emlxFile)),
    data.node.partNr.join('.'), // e.g. array [1, 1, 2]
  );
  // first try to get the name as explicitly specified in the email text
  // (this seems like the most reliable way), but if that does not work,
  // check the `Attachments` directory structure. See:
  // https://github.com/qqilihq/partial-emlx-converter/issues/3
  const fileNames = [data.node.filename, await getFilenameFromFileSystem(attachmentDirectoryPath)].filter(
    (f): f is string => !!f,
  );
  let processedAttachment = false;
  for (const fileName of fileNames) {
    const filePath = path.join(attachmentDirectoryPath, fileName);
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('error', (error) => reject(error));
        stream.on('close', () => resolve());
        stream.pipe(data.encoder);
      });
      processedAttachment = true;
      break;
    } catch (_e) {
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
    const files = (await fs.promises.readdir(pathToDirectory)).filter((file) => !file.startsWith('.DS_Store'));
    if (files.length !== 1) {
      const filenames = files.length > 0 ? `(${files.join(', ')})` : '';
      debug(
        `Couldn’t determine attachment; expected '${pathToDirectory}' ` +
          `to contain one file, but there were: ${files.length} ${filenames}`,
      );
      return null;
    } else {
      return files[0];
    }
  } catch (_e) {
    debug(`Couldn’t read attachments in '${pathToDirectory}'`);
    return null;
  }
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\..*/, '');
}

// emlx file contain the length of the 'payload' in the first line;
// this allows to strip away the plist epilogue at the end of the
// files easily
export class SkipEmlxTransform extends Transform {
  private bytesToRead: number | undefined = undefined;
  private bytesRead = 0;
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
    }
    callback(undefined, slicedChunk);
  }
}

export function processCli(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`${path.basename(process.argv[1])} input_directory output_directory [--ignoreErrors]`);
    process.exit(1);
  }
  let ignoreErrors = false;
  if (args.length > 2) {
    ignoreErrors = args[2] === '--ignoreErrors';
  }

  processEmlxs(/* inputDir */ args[0], /* outputDir */ args[1], ignoreErrors).catch((err) => console.error(err));
}
