import * as fs from 'fs';
import * as glob from 'glob';
import * as stream from 'stream';
import * as path from 'path';
import * as ProgressBar from 'progress';
import * as util from 'util';
import * as commander from 'commander';
import * as plist from 'plist';
import * as imap from 'imapflow';

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

async function setupEnv(inputDir: string) {
  const files = await util.promisify(glob)('**/*.emlx', { cwd: inputDir });
  const bar = new ProgressBar('Converting [:bar] :percent :etas :file', { total: files.length, width: 40 });
  return { files, bar };
}

export async function processEmlxs(
  inputDir: string,
  outputDir: string,
  ignoreErrors?: boolean,
  skipDeleted?: boolean
): Promise<void> {
  const { files, bar } = await setupEnv(inputDir);
  for (const file of files) {
    bar.tick({ file });
    const resultPath = path.join(outputDir, `${stripExtension(path.basename(file))}.eml`);
    try {
      const writeStream = fs.createWriteStream(resultPath);
      const res = await processEmlx(path.join(inputDir, file), writeStream, ignoreErrors, skipDeleted);
      res.messages.forEach(message => bar.interrupt(`${file}: ${message}`));
    } catch (e) {
      if (e instanceof DeletedMessageError && e.message == 'DELETED') {
        bar.interrupt(`${file}: Message is marked as deleted (skipped)`);
        fs.unlinkSync(resultPath);
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

export async function imapImport(
  inputDir: string,
  options: {
    port: number;
    ignoreErrors?: boolean;
    skipDeleted?: boolean;
    tls: 'yes' | 'no';
    host: string;
    user: string;
    pass: string;
    mailbox: string;
  }
): Promise<void> {
  const conn = new imap.ImapFlow({
    host: options.host,
    port: options.port,
    auth: {
      user: options.user,
      pass: options.pass
    },
    secure: options.tls == 'yes',
    logger: false
  });
  await conn.connect();
  const { files, bar } = await setupEnv(inputDir);
  try {
    for (const file of files) {
      bar.tick({ file });
      try {
        let writeStream: stream.Writable;
        const writeStreamCollector = new Promise<Buffer>(resolve => {
          writeStream = new (class extends stream.Writable {
            // _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
            _buf: Buffer[] = [];
            _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
              this._buf.push(chunk);
              callback();
            }
            _final(callback: (error?: Error | null) => void): void {
              resolve(Buffer.concat(this._buf));
              callback();
            }
          })();
        });
        const res = await processEmlx(
          path.join(inputDir, file),
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          writeStream!,
          options.ignoreErrors,
          options.skipDeleted
        );
        res.messages.forEach(message => bar.interrupt(`${file}: ${message}`));
        const msgData = await writeStreamCollector;
        const dateRecvTS = res.plData['date-received'] as number | undefined;
        let dateRecv: Date;
        if (!dateRecvTS) {
          throw new Error('no date-received in plist!'); // we could get 'Date' from message headers als fallback when this happens.
        } else {
          // Hint: this is the fix the timestamp to UTC
          dateRecv = new Date(dateRecvTS * 1000);
          const tzo = dateRecv.getTimezoneOffset();
          dateRecv = new Date((dateRecvTS - tzo) * 1000);
        }
        // map emlx flags to imap flags
        const imapFlags: string[] = [];
        for (const flag of res.flags) {
          if (flag == 'read') imapFlags.push('\\Seen');
          else if (flag == 'answered') imapFlags.push('\\Answered');
          else if (flag == 'deleted') imapFlags.push('\\Deleted');
          else if (flag == 'draft') imapFlags.push('\\Draft');
          else if (flag == 'flagged') imapFlags.push('\\Flagged');
        }
        await conn.append(options.mailbox, msgData, imapFlags, dateRecv);
      } catch (e) {
        if (e instanceof DeletedMessageError && e.message == 'DELETED') {
          bar.interrupt(`${file}: Message is marked as deleted (skipped)`);
          continue;
        }
        if (e instanceof Error) {
          bar.interrupt(`Caught Error: ${e.message}`);
          if (e.message.startsWith('Could not get attachment')) {
            bar.interrupt(
              `Encountered error when processing ${file} -- run with '--ignoreErrors' argument to avoid aborting the conversion.`
            );
          }
        }
        bar.terminate();
        throw e;
      }
    }
  } finally {
    await conn.logout();
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
): Promise<{ messages: string[]; flags: EmlxFlags[]; plData: plist.PlistObject }> {
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
      // console.log(`\n\n${emlxFile} ${JSON.stringify(data.node.parentNode.headers.lines, null, 2)}\n\n`);
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
  const emlxTransform = new SkipEmlxTransform(skipDeleted);
  await util.promisify(pipeline)(
    fs.createReadStream(emlxFile),
    emlxTransform,
    new Splitter(),
    rewriter,
    new Joiner(),
    resultStream
  );
  return { messages: messages, flags: emlxTransform.flags, plData: emlxTransform.plData };
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
  public readonly flags: EmlxFlags[] = [];
  public plData: plist.PlistObject = {};

  constructor(skipDeleted = false) {
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
    try {
      this.plData = plist.parse(plistDict) as plist.PlistObject;

      // the flags are documented here: https://docs.fileformat.com/email/emlx/
      const flagsVal = this.plData['flags'] as number;
      let flagBit = 0;
      for (const flagName of EmlxFlagNames) {
        const mask = 1 << flagBit;
        if (flagsVal & mask) {
          this.flags.push(flagName);
        }
        if (flagBit == 9) {
          // flags jump from bit 9 to bit 23 (10-15: attachment count; 16-22: prio)
          flagBit = 23;
        } else {
          flagBit++;
        }
      }
    } catch {
      // ignore plist parsing errors
    }

    // skip deleted messages
    if (this.skipDeleted && this.flags.includes('deleted')) {
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

  program
    .command('imapImport')
    .description('Import mails from emlx to IMAP server')
    .option('-p,--port <port_number>', 'IMAP port', parseInt, 993)
    .requiredOption('-u,--user <username>', 'User for IMAP authentication')
    .addOption(
      new commander.Option('--pass <password>', 'Password for IMAP authentication')
        .makeOptionMandatory(true)
        .env('IMAP_PASS')
    )
    .requiredOption('-h,--host <hostname>', 'IMAP server hostname')
    .requiredOption('-m,--mailbox <mailbox>', 'IMAP mailbox to import mails into', 'import')
    .addOption(
      new commander.Option('--tls <mode>', 'Use `no` to disable TLS')
        .choices(['yes', 'no'])
        .default('yes', 'tls enabled')
    )
    .option('--skipDeleted', 'Skip messages marked as deleted')
    .option('--ignoreErrors', "Don't abort conversion on error (see the log output for details in this case)")
    .argument('<input_directory>', 'input folder to read .emlx-files from')
    .action((input: string, options) => {
      imapImport(input, options).catch(err => console.error(err));
    });

  program.parse(process.argv);
}
