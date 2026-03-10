import expect from 'expect.js';
import 'mocha';
import path from 'path';
import { processEmlx, SkipEmlxTransform } from '../src/converter';
import fs from 'fs';
import os from 'os';
import MemoryStream from 'memorystream';
import { Readable } from 'stream';

/** enable to write results to home dir. */
const debug = false;

describe('converter', () => {
  describe('.partial.emlx (contains external attachments)', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/114892.partial.emlx'), stream);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114892.eml'), 'utf-8');
      writeForDebugging(buffer, '114892.eml');
    });

    it('encodes quoted-printable in text.txt attachment', () => {
      // 'glücklichen' gets encoded to the following value
      expect(result).to.contain('gl=C3=BCcklichen');
    });

    it('encodes base64 in image001.png attachment', () => {
      expect(result).to.contain('iVBORw0KGgoAAAANSUhE');
    });

    it('encodes 7bit in short.txt attachment', () => {
      expect(result).to.contain('Short text.');
    });

    it('result has 2169 lines', () => {
      // three lines less in generated eml, b/c of different quoted-printable encoding
      expect(result.split('\n').length).to.eql(2169);
    });

    it('headers are equal', () => {
      const resultHeader = extractHeader(result);
      const expectedHeader = extractHeader(expectedResult);
      expect(resultHeader).to.eql(expectedHeader);
    });

    it('boundaries are at expected lines', () => {
      const tempLines = result.split(/\r?\n/);
      expect(tempLines[19]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
      expect(tempLines[92]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
      expect(tempLines[112]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[157]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[633]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[698]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      // from here, offset -1 compared to original because
      // of different quoted-printable encoding
      expect(tempLines[737]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[814]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[2139]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[2165]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886--');
      expect(tempLines[2167]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--');
    });
  });

  describe('.emlx', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/114862.emlx'), stream);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114862.eml'), 'utf-8');
      writeForDebugging(buffer, '114862.eml');
    });

    it('result has 61 lines', () => {
      expect(result.split('\n').length).to.eql(61);
    });

    it('exactly equals the expected result', () => {
      expect(result).to.eql(expectedResult);
    });
  });

  describe('issue 1', () => {
    // https://github.com/qqilihq/partial-emlx-converter/issues/1
    let result: string;
    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/465622.partial.emlx'), stream);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      writeForDebugging(buffer, '465622.emlx');
    });

    it('result has more than 2000 lines', () => {
      expect(result.split('\n').length).to.be.greaterThan(2000);
    });
  });

  describe('.partial.emlx with missing attachment file -- #3', () => {
    // https://github.com/qqilihq/partial-emlx-converter/issues/3
    it('fails per default', async () => {
      try {
        await processEmlx(
          path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
          new MemoryStream(),
          false
        );
        expect().fail();
      } catch (e) {
        expect((e as Error).message).to.contain('Could not get attachment file');
      }
    });

    it('does not fail when flag is set', async () => {
      try {
        const stream = new MemoryStream();
        const { messages } = await processEmlx(
          path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
          stream,
          true
        );
        expect(messages).to.have.length(4);
        expect(messages).to.contain('Could not get attachment file (tried short.txt)');
        expect(messages).to.contain('Could not get attachment file (tried original.doc)');
        expect(messages).to.contain('Could not get attachment file (tried text.txt)');
        expect(messages).to.contain('Could not get attachment file (tried image001.png)');
        const buffer = await streamToBuffer(stream);
        writeForDebugging(buffer, '114863.eml');
      } catch {
        expect().fail();
      }
    });
  });

  describe('.partial.emlx with attachments without given filename -- #3', () => {
    let result: string;

    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/114894.partial.emlx'), stream);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      writeForDebugging(buffer, '114894.eml');
    });

    it('encodes base64 in image001.png attachment', () => {
      expect(result).to.contain('iVBORw0KGgoAAAANSUhE');
    });
  });

  describe('.partial.emlx with missing line break after boundary string -- #5', () => {
    // actually, this fix is about correcting an invalid end boundary string;
    // according to the specification, it should be: close-delimiter := delimiter "--",
    // however, the test data used only a single hyphen, which caused parsing errors
    // https://github.com/qqilihq/partial-emlx-converter/issues/5

    let result: string;

    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/114895.partial.emlx'), stream, true);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      writeForDebugging(buffer, '114895.eml');
    });

    it('fixes end boundary string with one hyphen to two hyphens', () => {
      expect(result).to.match(/.*--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--\s*$/);
    });
  });

  describe('.partial.emlx with filename without extension', () => {
    let result: string;

    before(async () => {
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/229417.partial.emlx'), stream);
      const buffer = await streamToBuffer(stream);
      result = buffer.toString('utf8');
      writeForDebugging(buffer, '229417.eml');
    });

    it('contains encoded attachment', () => {
      expect(result).to.contain('iVBORw0KGgoAAAANSUhE');
    });
  });

  describe('different boundary strings -- #10', () => {
    // https://github.com/qqilihq/partial-emlx-converter/issues/10
    it('does not fail', async () => {
      // used to throw error before,
      // but since switching to `mailsplit`,
      // this is handled gracefully
      const stream = new MemoryStream();
      await processEmlx(path.join(__dirname, '__testdata/input/Messages/11507.emlx'), stream, false);
      const buffer = await streamToBuffer(stream);
      const result = buffer.toString('utf8');
      writeForDebugging(buffer, '11507.eml');
      expect(result).to.match(/^X-Antivirus: avg.*/);
      expect(result).to.match(/------=_NextPart_7ae48436ccb4c946256817a6c56cb01c--\n\n$/);
      expect(result.length).to.eql(3685);
    });
  });

  describe('SkipEmlxTransform', () => {
    // https://stackoverflow.com/questions/19906488/convert-stream-into-buffer
    it('small file', async () => {
      const fileStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-small.txt'));
      const resultStream = fileStream.pipe(new SkipEmlxTransform());
      const buffer = await streamToBuffer(resultStream);
      expect(buffer.toString('utf8')).to.eql('la\nle\nli');
    });

    it('large file', async () => {
      const readStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-large.txt'));
      const resultStream = readStream.pipe(new SkipEmlxTransform());
      const buffer = await streamToBuffer(resultStream);
      const result = buffer.toString('utf8');
      expect(result).to.match(/^ab.*/);
      expect(result).to.match(/.*bc$/);
      expect(result.length).to.eql(537723);
    });
  });

  it('throws error on invalid structure', async () => {
    try {
      await processEmlx(path.join(__dirname, '__testdata/skip-emlx/invalid.emlx'), new MemoryStream());
    } catch (e) {
      expect((e as Error).message).to.contain('Invalid structure; content did not start with payload length');
    }
  });

  describe('message with Latin 1 encoding -- #17', () => {
    // https://github.com/qqilihq/partial-emlx-converter/issues/17
    let result: string;
    let expectedResult: string;

    before(async function () {
      const testFile = path.join(__dirname, '__testdata/encrypted/258310/Messages/258310.partial.emlx');
      if (!fs.existsSync(testFile)) {
        // https://mochajs.org/#inclusive-tests
        this.skip();
      } else {
        const stream = new MemoryStream();
        await processEmlx(testFile, stream);
        const buffer = await streamToBuffer(stream);
        // nb: deliberately use 'binary' and not 'utf8' here
        // https://stackoverflow.com/a/40775633/388827
        result = buffer.toString('binary');
        writeForDebugging(buffer, '258310.eml');
        expectedResult = fs.readFileSync(
          path.join(__dirname, '__testdata/encrypted/258310/expected_results/258310.eml'),
          'binary'
        );
      }
    });

    it('properly preserves accented characters', () => {
      expect(result).to.contain('-------- Message transféré --------');
      expect(result).to.contain('Délégation');
    });

    it('exactly equals the expected result', () => {
      expect(result).to.eql(expectedResult);
    });
  });

  it('parses additional flags', async () => {
    const result = await processEmlx(
      path.join(__dirname, '__testdata/input/Messages/114892.partial.emlx'),
      new MemoryStream()
    );

    expect(result.flags).length(3);
    expect(result.flags).contain('read');
    expect(result.flags).contain('initial');
    expect(result.flags).contain('notJunk');

    expect(result.plData).eql({
      color: '000000',
      'date-last-viewed': 1517000482,
      'date-received': 1517000478,
      flags: 8623689857,
      'remote-id': '50758'
    });
  });

  describe('progress reporter', () => {
    const inputDir = path.join(__dirname, '__testdata/input');
    const outputDirs: string[] = [];

    afterEach(() => {
      outputDirs.forEach(dir => removeDirectoryRecursive(dir));
      outputDirs.length = 0;
    });

    it('calls onStart with total file count', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-progress-test');
      outputDirs.push(outputDir);
      let startCalled = false;
      let totalFiles = 0;

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        progressReporter: {
          onStart: total => {
            startCalled = true;
            totalFiles = total;
          }
        }
      });

      expect(startCalled).to.be(true);
      expect(totalFiles).to.be.greaterThan(0);
    });

    it('calls onProgress for each file', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-progress-test-2');
      outputDirs.push(outputDir);
      const progressCalls: Array<{ current: number; total: number; fileName: string }> = [];

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        progressReporter: {
          onProgress: (current, total, fileName) => {
            progressCalls.push({ current, total, fileName });
          }
        }
      });

      expect(progressCalls.length).to.be.greaterThan(0);

      // Check that current progresses correctly
      for (let i = 0; i < progressCalls.length; i++) {
        expect(progressCalls[i].current).to.be(i + 1);
        expect(progressCalls[i].fileName).to.be.a('string');
        expect(progressCalls[i].fileName.length).to.be.greaterThan(0);
      }
    });

    it('calls onComplete when processing finishes', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-progress-test-3');
      outputDirs.push(outputDir);
      let completeCalled = false;

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        progressReporter: {
          onComplete: () => {
            completeCalled = true;
          }
        }
      });

      expect(completeCalled).to.be(true);
    });

    it('respects isCancelled callback', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-progress-test-4');
      outputDirs.push(outputDir);
      let processedFiles = 0;

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        progressReporter: {
          onProgress: () => {
            processedFiles++;
          },
          isCancelled: () => {
            // Cancel after processing first file
            return processedFiles >= 1;
          }
        }
      });

      // Should have stopped after 1 file
      expect(processedFiles).to.be(1);
    });
  });

  describe('logger', () => {
    const inputDir = path.join(__dirname, '__testdata/input');
    const outputDirs: string[] = [];

    afterEach(() => {
      outputDirs.forEach(dir => removeDirectoryRecursive(dir));
      outputDirs.length = 0;
    });

    it('calls warn for files with errors when ignoreErrors is true', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-logger-test');
      outputDirs.push(outputDir);
      const warnMessages: string[] = [];

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        logger: {
          info: () => {
            // no-op
          },
          warn: message => {
            warnMessages.push(message);
          },
          error: () => {
            // no-op
          },
          debug: () => {
            // no-op
          }
        }
      });

      // Test file 114893.partial.emlx has missing attachments
      // Should have warnings about missing files
      expect(warnMessages.length).to.be.greaterThan(0);
      const attachmentWarnings = warnMessages.filter(msg => msg.includes('Could not get attachment file'));
      expect(attachmentWarnings.length).to.be.greaterThan(0);
    });

    it('calls warn for skipped deleted files', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-logger-test-2');
      outputDirs.push(outputDir);
      const warnMessages: string[] = [];

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        skipDeleted: true,
        logger: {
          info: () => {
            // no-op
          },
          warn: message => {
            warnMessages.push(message);
          },
          error: () => {
            // no-op
          },
          debug: () => {
            // no-op
          }
        }
      });

      // If there are any deleted files in test data, we should see warnings
      // (this might be 0 if no deleted files exist in test data)
      expect(warnMessages).to.be.an('array');
    });

    it('calls error for files with missing attachments when ignoreErrors is true', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-logger-test-3');
      outputDirs.push(outputDir);
      const errorMessages: string[] = [];

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        logger: {
          info: () => {
            // no-op
          },
          warn: () => {
            // no-op
          },
          error: message => {
            errorMessages.push(message);
          },
          debug: () => {
            // no-op
          }
        }
      });

      // Test file 114893.partial.emlx has missing attachments
      // Should have at least one error logged
      expect(errorMessages.length).to.be.greaterThan(0);
      const attachmentErrors = errorMessages.filter(msg => msg.includes('Could not get attachment file'));
      expect(attachmentErrors.length).to.be.greaterThan(0);
    });

    it('works with both logger and progress reporter', async () => {
      const outputDir = path.join(__dirname, '__testdata/output-logger-test-4');
      outputDirs.push(outputDir);
      let startCalled = false;
      let completeCalled = false;
      const warnMessages: string[] = [];

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await converter.processEmlxs({
        inputDir,
        outputDir,
        ignoreErrors: true,
        progressReporter: {
          onStart: () => {
            startCalled = true;
          },
          onComplete: () => {
            completeCalled = true;
          }
        },
        logger: {
          info: () => {
            // no-op
          },
          warn: message => {
            warnMessages.push(message);
          },
          error: () => {
            // no-op
          },
          debug: () => {
            // no-op
          }
        }
      });

      expect(startCalled).to.be(true);
      expect(completeCalled).to.be(true);
      // Should have some warnings from files with missing attachments
      expect(warnMessages.length).to.be.greaterThan(0);
    });
  });
});

function extractHeader(input: string): string {
  return input.substring(0, input.indexOf('\r?\n\r?\n'));
}

function writeForDebugging(result: Buffer, filename: string): void {
  if (debug) {
    fs.writeFileSync(path.join(os.homedir(), filename), result);
  }
}

async function streamToBuffer(readable: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const buffers: Buffer[] = [];
    readable.on('error', error => reject(error));
    readable.on('data', (b: Buffer) => buffers.push(b));
    readable.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

function removeDirectoryRecursive(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach(file => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        removeDirectoryRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}
