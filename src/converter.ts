#!/usr/bin/env node

import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import * as ProgressBar from 'progress';
import * as util from 'util';
// @ts-ignore
import { Splitter, Joiner, Rewriter } from 'mailsplit';
import { Transform, TransformCallback, pipeline, Writable } from 'stream';

export async function processEmlxs(inputDir: string, outputDir: string, ignoreErrors?: boolean): Promise<void> {
  const files = await util.promisify(glob)('**/*.emlx', { cwd: inputDir });
  const bar = new ProgressBar('Converting [:bar] :percent :etas :file', { total: files.length, width: 40 });
  for (const file of files) {
    bar.tick({ file });
    try {
      const resultPath = path.join(outputDir, `${stripExtension(path.basename(file))}.eml`);
      const writeStream = fs.createWriteStream(resultPath);
      await processEmlx(path.join(inputDir, file), writeStream, ignoreErrors);
    } catch (e) {
      if (ignoreErrors) {
        bar.interrupt(`Skipped file ${file}: ${e}`);
      } else {
        console.log(
          `Encountered error when processing ${file} -- run with '--ignoreErrors' argument to avoid aborting the conversion.`
        );
        throw e;
      }
    }
  }
}

// 'X-Apple-Content-Length' denotes an external attachment in case of .partial.emlx
const appleContentLengthHeader = 'X-Apple-Content-Length';

export async function processEmlx(
  emlxFile: string,
  resultStream: Writable,
  ignoreMissingAttachments = false
): Promise<void> {
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
      integrateAttachment(emlxFile, data, ignoreMissingAttachments)
        // propagate error event
        .catch(err => rewriter.emit('error', err));
    });
  });
  await util.promisify(pipeline)(
    fs.createReadStream(emlxFile),
    new SkipEmlxTransform(),
    new Splitter(),
    rewriter,
    new Joiner(),
    resultStream
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function integrateAttachment(emlxFile: string, data: any, ignoreMissingAttachments: boolean): Promise<void> {
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
    const message = `Could not get attachment file (tried ${fileNames.join(', ')})`;
    if (ignoreMissingAttachments) {
      console.log(`[warn] ${message}`);
      data.encoder.end();
    } else {
      throw new Error(message);
    }
  }
}

/**
 * In case we cannot extract the attachment filename from the
 * email, we detrmine it by looking into the file system. We
 * expect, that the corresponding attachment directory
 * (e.g. `1.2`) contains exactly *one* file (ignoring files
 * starting with a `.`, to prevent errors when a `.DS_Store`
 * exists).
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
    // ignore .dot files, e.g. `.DS_Store`
    const files = (await fs.promises.readdir(pathToDirectory)).filter(file => !file.startsWith('.'));
    if (files.length !== 1) {
      console.log(
        `Couldn’t determine attachment; expected '${pathToDirectory}' ` +
          `to contain one file, but there were: ${files.join(', ')}`
      );
      return null;
    } else {
      return files[0];
    }
  } catch (e) {
    console.log(`Couldn’t read attachments in '${pathToDirectory}'`);
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
        const nextChars = chunk.slice(offset + length, offset + length + 5).toString('utf8');
        if (nextChars === '<?xml') {
          slicedChunk = Buffer.concat([slicedChunk, Buffer.from('-')]);
        }
      }
    }
    callback(undefined, slicedChunk);
  }
}

// CLI only when module is not require'd
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`${__filename} input_directory output_directory [--ignoreErrors]`);
    process.exit(1);
  }
  let ignoreErrors = false;
  if (args.length > 2) {
    ignoreErrors = args[2] === '--ignoreErrors';
  }

  processEmlxs(/* inputDir */ args[0], /* outputDir */ args[1], ignoreErrors).catch(err => console.error(err));
}
