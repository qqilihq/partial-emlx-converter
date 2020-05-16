#!/usr/bin/env node

import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
// @ts-ignore
import * as emlformat from 'eml-format';
import * as parseRfc2047 from 'rfc2047';
import * as parseContentDisposition from 'content-disposition';
import * as parseContentType from 'content-type';
import * as libqp from 'libqp';
import * as ProgressBar from 'progress';
import * as util from 'util';

type Headers = { [key: string]: string };

interface IContent {
  headers: Headers;
  body: IPart[] | string;
}

interface IPart {
  boundary: string;
  part: IContent;
}

/** CR+LF seems to be more common than just LF. */
const eol = '\r\n';

const encodedLineLength = 76;

/** Newline was inserted subsequently; needs to be stripped away afterwards. */
const removeNewlineMarker = eol + '__remove_newline__' + eol;

export async function processEmlxs (inputDir: string, outputDir: string, ignoreErrors?: boolean): Promise<void> {
  const files = await util.promisify(glob)('**/*.emlx', { cwd: inputDir });
  const bar = new ProgressBar('Converting [:bar] :percent :etas :file', { total: files.length, width: 40 });
  for (const file of files) {
    bar.tick({ file });
    try {
      const emlContent = await processEmlx(path.join(inputDir, file), ignoreErrors);
      const resultPath = path.join(outputDir, `${stripExtension(path.basename(file))}.eml`);
      await fs.promises.writeFile(resultPath, emlContent);
    } catch (e) {
      if (ignoreErrors) {
        bar.interrupt(`Skipped file ${file}: ${e}`);
      } else {
        console.log(`Encountered error when processing ${file} -- run with '--ignoreErrors' argument to avoid aborting the conversion.`);
        throw e;
      }
    }
  }
}

export async function processEmlx (emlxFile: string, ignoreMissingAttachments: boolean = false): Promise<string> {

  const rawEmlx = await fs.promises.readFile(emlxFile, 'utf8');

  const payload = extractPayload(rawEmlx);

  const lines = payload.split(/\r?\n/);

  // dirty fix for https://github.com/qqilihq/partial-emlx-converter/issues/1
  // the eml-format lib treats the 'Content-Type' case sensitively
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx] === '') break;
    lines[idx] = lines[idx].replace(/^Content-Type:\s/mi, 'Content-Type: ');
  }

  const preprocessedEmlx = preprocessBoundaries(lines).join(eol);

  const appender: string[] = [];

  const headers = lines.slice(0, lines.indexOf('')).join(eol);

  const data = await parseEmlFormat(preprocessedEmlx);

  if (Array.isArray(data.body)) {

    await transform(data.body, emlxFile, ignoreMissingAttachments);

    // write the eml data (do not use read/build from 'eml-format',
    // because they flatten the structure)
    writeBody(data.body, appender);

  } else {
    appender.push(data.body);
  }

  // fix: remove the newline markers (and the following newline :)
  const payloadResult = appender.join(eol).replace(new RegExp(removeNewlineMarker + eol, 'g'), '');

  return headers + eol + eol + eol + payloadResult + eol;

}

function parseEmlFormat (input: string): Promise<IContent> {
  return util.promisify(emlformat.parse)(input);
}

function writeBody (parts: IPart[], appender: string[]) {

  if (appender.length > 0) {
    appender.push('');
  }

  let boundary: string | undefined;

  parts.forEach(part => {

    // process boundary character;
    // perform sanity check -- all parts
    // in this series should have the
    // same boundary character
    appender.push('--' + part.boundary);
    if (boundary && part.boundary !== boundary) {
      throw new Error(`Different boundary strings (expected '${boundary}', got: '${part.boundary}')`);
    }
    boundary = part.boundary;

    // write the headers
    for (const key in part.part.headers) {
      // multi line values are indented from the second line
      const value = part.part.headers[key].replace(/(\r?\n)/g, '$1\t');
      appender.push(`${key}: ${value}`);
    }

    appender.push('');

    // process the body
    if (Array.isArray(part.part.body)) { // nested parts
      writeBody(part.part.body, appender);
      appender.push('');
    } else { // string or buffer data
      appender.push(part.part.body);
    }
  });

  appender.push('--' + boundary + '--');
}

async function transform (parts: IPart[], emlxFile: string, ignoreMissingAttachments: boolean) {
  for (let index = 0; index < parts.length; index++) {
    await transformRec(parts[index], emlxFile, [ index + 1 ], ignoreMissingAttachments);
  }
}

// process the body parts (recursively);
// in case there's 'X-Apple-Content-Length'
// attribute, add the actual base64 content
// to the part and remove the property
async function transformRec (part: IPart, emlxFile: string, indexPath: number[], ignoreMissingAttachments: boolean) {
  if (Array.isArray(part.part.body)) {
    for (let index = 0; index < part.part.body.length; index++) {
      await transformRec(part.part.body[index], emlxFile, indexPath.concat(index + 1), ignoreMissingAttachments);
    }
  } else
  // 'X-Apple-Content-Length' denotes an external attachment
  if (part.part.headers['X-Apple-Content-Length']) {
    delete part.part.headers['X-Apple-Content-Length'];
    const attachmentDirectoryPath = path.join(
      path.dirname(emlxFile),
      '..',
      'Attachments',
      stripExtension(path.basename(emlxFile)),
      indexPath.join('.')
    );
    // first try to get the name as explicitly specified in the email text
    // (this seems like the most reliable way), but if that does not work,
    // check the `Attachments` directory structure. See:
    // https://github.com/qqilihq/partial-emlx-converter/issues/3
    const fileNames = [
      getFilenameFromEmail(part.part.headers),
      await getFilenameFromFileSystem(attachmentDirectoryPath)
    ].filter((f): f is string => !!f);
    let fileBuffer;
    for (const fileName of fileNames) {
      const filePath = path.join(attachmentDirectoryPath, fileName);
      try {
        fileBuffer = await fs.promises.readFile(filePath);
        break;
      } catch (e) {
        // ignore here, keep trying
      }
    }
    if (!fileBuffer) {
      const message = `Could not get attachment file (tried ${fileNames.join(', ')})`;
      if (ignoreMissingAttachments) {
        console.log(`[warn] ${message}`);
        fileBuffer = Buffer.alloc(0);
      } else {
        throw new Error(message);
      }
    }
    const encoding = part.part.headers['Content-Transfer-Encoding'];
    part.part.body = encode(encoding, fileBuffer)
                      // make sure, that we use CR+LF everywhere
                      .replace(/\r?\n/g, eol);
  }
}

function getFilenameFromEmail (headers: Headers) {

  // this gives a good overview of the plethora of encoding types:
  // http://test.greenbytes.de/tech/tc2231/

  try {
    const contentDisposition = headers['Content-Disposition'];
    if (contentDisposition) {
      // this also takes care of RFC 2231/5987
      // https://www.greenbytes.de/tech/webdav/rfc5987.html
      const parsed = parseContentDisposition.parse(removeLinebreaks(contentDisposition));
      // if applicable, decode RFC 2047 encoded filename
      // (this will just return the original name, in case
      // RFC 2047 does not apply)
      // https://www.greenbytes.de/tech/webdav/rfc2047.html
      return parseRfc2047.decode(parsed.parameters.filename);
    }
  } catch (e) {
    // ignore
  }

  try {
    const contentType = headers['Content-Type'];
    if (contentType) {
      const parsed = parseContentType.parse(removeLinebreaks(contentType));
      return parsed.parameters.name;
    }
  } catch (e) {
    // ignore
  }

  return null;
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
async function getFilenameFromFileSystem (pathToDirectory: string) {
  try {
    // ignore .dot files, e.g. `.DS_Store`
    const files = (await fs.promises.readdir(pathToDirectory)).filter(file => !file.startsWith('.'));
    if (files.length !== 1) {
      console.log(`Couldn’t determine attachment; expected '${pathToDirectory}' ` +
                  `to contain one file, but there were: ${files.join(', ')}`);
      return null;
    } else {
      return files[0];
    }
  } catch (e) {
    console.log(`Couldn’t read attachments in '${pathToDirectory}'`);
    return null;
  }
}

function removeLinebreaks (value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function wrap (value: string): string {
  return value.replace(new RegExp(`(.{${encodedLineLength}})`, 'g'), `$1${eol}`);
}

function stripExtension (fileName: string) {
  return fileName.replace(/\..*/, '');
}

// eml-format expects boundary strings to be preceeded
// by a blank line, Mail.app does NOT always set blank
// lines though as I found during some experiments --
// not sure, who's right here
function preprocessBoundaries (lines: string[]): string[] {
  const boundaries: string[] = [];
  lines.forEach((line, idx) => {
    const boundary = emlformat.getBoundary(line);
    if (boundary) {
      boundaries.push('--' + boundary);
      boundaries.push('--' + boundary + '--');
    }

    // boundary line currently NOT preceeded by blank line?
    if (boundaries.includes(line) && lines[idx - 1] !== '') {
      // add a preceeding newline character
      // console.log(`adding preceeding newline @ ${idx}: ${lines[idx]}`);
      lines[idx - 1] = lines[idx - 1] + removeNewlineMarker;
      lines[idx] = eol + lines[idx];
    } else if (line.endsWith('-')) {
      // fix for #5 -- an end boundary string which is only terminated
      // with a single '-' is corrected to double '--' here
      boundaries.filter(boundary => !boundary.endsWith('--')).forEach(b => {
        if (line === `${b}-`) {
          lines[idx] = `${lines[idx]}-`;
        }
      });
    }
  });
  return lines;
}

// emlx file contain the length of the 'payload' in the first line;
// this allows to strip away the plist epilogue at the end of the
// files easily
function extractPayload (content: string): string {
  const payloadLengthMatch = content.match(/^(\d+)\s+/);
  if (!payloadLengthMatch) {
    throw new Error('Invalid structure; content did not start with payload length as expected');
  }
  const payloadLength = parseInt(payloadLengthMatch[1], 10);
  return content.substring(
    payloadLengthMatch[0].length,
    payloadLengthMatch[0].length + payloadLength
  );
}

function encode (encoding: string, data: Buffer): string {
  // https://www.w3.org/Protocols/rfc1341/5_Content-Transfer-Encoding.html
  // 7bit is the default if not explicitly specified
  // https://stackoverflow.com/a/28531705/388827
  const encodingTemp = encoding ? encoding.toLowerCase() : '7bit';
  switch (encodingTemp) {
    case 'base64':
      return wrap(data.toString('base64'));
    case 'quoted-printable':
      return libqp.wrap(libqp.encode(data), encodedLineLength);
    case '7bit':
    case '8bit':
    case 'binary':
      return data.toString('utf8');
    default:
      throw new Error(`Unimplemented encoding: ${encoding}`);
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
