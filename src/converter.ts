import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import * as emlformat from 'eml-format';

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

const base64lineLength = 76;

export function processEmlxs (inputDir: string, outputDir: string) {
  glob('**/*.emlx', { cwd: inputDir }, async (err, files) => {
    if (err) throw err;
    for (let f of files) {
      console.log(`Processing ${f}`);
      const emlContent = await processEmlx(path.join(inputDir, f));
      const resultPath = path.join(outputDir, `${stripExtension(path.basename(f))}.eml`);
      fs.writeFileSync(resultPath, emlContent);
    }
  });
}

export function processEmlx (emlxFile: string): Promise<string> {

  const rawEmlx = fs.readFileSync(emlxFile, 'utf8');
  const lines = rawEmlx.split(/\r?\n/);

  const preprocessedEmlx = removePlistEpilogue(
                                preprocessBoundaries(lines)).join(eol);

  const appender = [];

  const headers = lines.slice(1 /* drop first line */, lines.indexOf('')).join(eol);

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

      resolve(headers + eol + eol + appender.join(eol));

    });
  });
}

function writeBody (parts: IPart[], appender: string[]) {

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
      appender.push(`${key}: ${part.part.headers[key]}`);
    }

    // process the body
    if (Array.isArray(part.part.body)) { // nested parts
      writeBody(part.part.body, appender);
    } else { // string or buffer data
      appender.push('');
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
    part.part.body = wrap(fs.readFileSync(filePath).toString('base64'));
  }
}

function getFilename (headers) {
  const header = headers['Content-Disposition'] || headers['Content-Type'];
  if (!header) {
    return null;
  }
  // copied from eml-format.js
  const match = /name="?(.+?)"?$/gi.exec(header);
  return match ? match[1] : null;
}

function wrap (value: string): string {
  return value.replace(new RegExp(`(.{${base64lineLength}})`, 'g'), `$1${eol}`);
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
    }

    // boundary line currently NOT preceeded by blank line?
    if (boundaries.indexOf(line) !== -1 && lines[idx - 1] !== '') {
      // add a preceeding newline character
      lines[idx] = eol + lines[idx];
    }
  });
  return lines;
}

function removePlistEpilogue (lines: string[]): string[] {

  // <?xml version="1.0" encoding="UTF-8"?>
  // <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  // <plist version="1.0">
  // …
  // </plist>

  // go through the lines backward, and expect an </plist> at the end;
  // then keep going upwards until the <?xml …> element;
  let stripFrom = lines.length - 1;
  let readContent = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].length === 0) { // skip empty lines
      continue;
    }
    // end of epilogue, but only if it is at the end of the file
    // (just to be sure not to strip away any plist strings which
    // might occur *within* an email?!?!)
    if (!readContent && lines[index] === '</plist>') {
      continue;
    }
    readContent = true;
    // ok, we found the beginning, strip away until here
    if (lines[index] === '<?xml version="1.0" encoding="UTF-8"?>') {
      stripFrom = index;
      break;
    }
  }
  return lines.slice(0, stripFrom);
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
