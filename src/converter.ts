import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import * as emlformat from 'eml-format';
import * as parseRfc2047 from 'rfc2047';
import * as parseContentDisposition from 'content-disposition';
import * as parseContentType from 'content-type';
import * as libqp from 'libqp';

interface IContent {
  headers: object;
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
const removeNewlineMarker = '__remove_newline__';

export function processEmlxs (inputDir: string, outputDir: string) {
  glob('**/*.emlx', { cwd: inputDir }, async (err, files) => {
    if (err) throw err;
    for (const f of files) {
      console.log(`Processing ${f}`);
      const emlContent = await processEmlx(path.join(inputDir, f));
      const resultPath = path.join(outputDir, `${stripExtension(path.basename(f))}.eml`);
      fs.writeFileSync(resultPath, emlContent);
    }
  });
}

export function processEmlx (emlxFile: string): Promise<string> {

  const rawEmlx = fs.readFileSync(emlxFile, 'utf8');
  const payload = extractPayload(rawEmlx);

  const lines = payload.split(/\r?\n/);

  const preprocessedEmlx = preprocessBoundaries(lines).join(eol);

  const appender = [];

  const headers = lines.slice(0, lines.indexOf('')).join(eol);

  return new Promise<string>((resolve, reject) => {
    emlformat.parse(preprocessedEmlx, (err, data: IContent) => {
      if (err) return reject(err);

      if (Array.isArray(data.body)) {

        transform(data.body, emlxFile);

        // write the eml data (do not use read/build from 'eml-format',
        // because they flatten the structure)
        writeBody(data.body, appender);

      } else {
        appender.push(data.body);
      }

      // fix: remove the newline markers (and the following newline :)
      const payloadResult = appender.join(eol).replace(new RegExp(removeNewlineMarker + eol, 'g'), '');

      resolve(headers + eol + eol + eol + payloadResult + eol);

    });
  });
}

function writeBody (parts: IPart[], appender: string[]) {

  if (appender.length > 0) {
    appender.push('');
  }

  let boundary;

  parts.forEach(part => {

    // process boundary character;
    // perform sanity check -- all parts
    // in this series should have the
    // same boundary character
    appender.push('--' + part.boundary);
    if (boundary && part.boundary !== boundary) {
      throw new Error('Different boundary strings');
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

function transform (parts: IPart[], emlxFile: string) {
  parts.forEach((part, index) => transformRec(part, emlxFile, [ index + 1 ]));
}

// process the body parts (recursively);
// in case there's 'X-Apple-Content-Length'
// attribute, add the actual base64 content
// to the part and remove the property
function transformRec (part: IPart, emlxFile: string, indexPath: number[]) {
  if (Array.isArray(part.part.body)) {
    part.part.body.forEach((part, index) =>
      transformRec(part, emlxFile, indexPath.concat(index + 1)));
  } else
  // 'X-Apple-Content-Length' denotes an external attachment
  if (part.part.headers['X-Apple-Content-Length']) {
    delete part.part.headers['X-Apple-Content-Length'];
    const filePath = path.join(
      path.dirname(emlxFile),
      '..',
      'Attachments',
      stripExtension(path.basename(emlxFile)),
      indexPath.join('.'),
      getFilename(part.part.headers));
    const encoding = part.part.headers['Content-Transfer-Encoding'];
    const fileBuffer = fs.readFileSync(filePath);
    part.part.body = encode(encoding, fileBuffer);
  }
}

function getFilename (headers) {

  // this gives a good overview of the plethora of encoding types:
  // http://test.greenbytes.de/tech/tc2231/

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

  const contentType = headers['Content-Type'];

  if (contentType) {

    const parsed = parseContentType.parse(removeLinebreaks(contentType));
    return parsed.parameters.name;

  }

  return null;
}

function removeLinebreaks (value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function wrap (value: string): string {
  return value.replace(new RegExp(`(.{${encodedLineLength}})`, 'g'), `$1${eol}`);
}

function stripExtension (fileName) {
  return fileName.replace(/\..*/, '');
}

// eml-format expects boundary strings to be preceeded
// by a blank line, Mail.app does NOT always set blank
// lines though as I found during some experiments --
// not sure, who's right here
function preprocessBoundaries (lines: string[]): string[] {
  const boundaries = [];
  lines.forEach((line, idx) => {
    const boundary = emlformat.getBoundary(line);
    if (boundary) {
      boundaries.push('--' + boundary);
      boundaries.push('--' + boundary + '--');
    }

    // boundary line currently NOT preceeded by blank line?
    if (boundaries.indexOf(line) !== -1 && lines[idx - 1] !== '') {
      // add a preceeding newline character
      // console.log(`adding preceeding newline @ ${idx}: ${lines[idx]}`);
      lines[idx - 1] = lines[idx - 1] + removeNewlineMarker;
      lines[idx] = eol + lines[idx];
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
  switch (encoding) {
    case 'base64':
      return wrap(data.toString('base64'));
    case 'quoted-printable':
      return libqp.wrap(libqp.encode(data), encodedLineLength)
                    // make sure, that we use CR+LF everywhere
                    .replace(/\r?\n/g, eol);
    default:
      throw new Error(`Unimplemented encoding: ${encoding}`);
  }
}

// CLI only when module is not require'd
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(`${__filename} input_directory output_directory`);
    process.exit(1);
  }

  processEmlxs(/* inputDir */ args[0], /* outputDir */ args[1]);
}
