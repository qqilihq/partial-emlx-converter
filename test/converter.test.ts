import expect = require('expect.js');
import 'mocha';
import * as path from 'path';
import * as converter from '../src/converter';
import * as fs from 'fs';
import * as os from 'os';
import MemoryStream = require('memorystream');
import { Readable } from 'stream';

/** enable to write results to home dir. */
const debug = false;

describe('converter', () => {
  describe('.partial.emlx (contains external attachments)', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      const stream = new MemoryStream();
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114892.partial.emlx'), stream);
      result = await streamToString(stream);
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114892.eml'), 'utf-8');
      writeForDebugging(result, '114892.eml');
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
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114862.emlx'), stream);
      result = await streamToString(stream);
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114862.eml'), 'utf-8');
      writeForDebugging(result, '114862.eml');
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
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/465622.partial.emlx'), stream);
      result = await streamToString(stream);
      writeForDebugging(result, '465622.emlx');
    });

    it('result has more than 2000 lines', () => {
      expect(result.split('\n').length).to.be.greaterThan(2000);
    });
  });

  describe('.partial.emlx with missing attachment file -- #3', () => {
    // https://github.com/qqilihq/partial-emlx-converter/issues/3
    it('fails per default', async () => {
      try {
        await converter.processEmlx(
          path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
          new MemoryStream(),
          false
        );
        expect().fail();
      } catch (e) {
        expect(e.message).to.contain('Could not get attachment file');
      }
    });

    it('does not fail when flag is set', async () => {
      try {
        const stream = new MemoryStream();
        await converter.processEmlx(
          path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
          stream,
          true
        );
        const result = await streamToString(stream);
        writeForDebugging(result, '114863.eml');
      } catch (e) {
        expect().fail();
      }
    });
  });

  describe('.partial.emlx with attachments without given filename -- #3', () => {
    let result: string;

    before(async () => {
      const stream = new MemoryStream();
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114894.partial.emlx'), stream);
      result = await streamToString(stream);
      writeForDebugging(result, '114894.eml');
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
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114895.partial.emlx'), stream, true);
      result = await streamToString(stream);
      writeForDebugging(result, '114895.eml');
    });

    it('fixes end boundary string with one hyphen to two hyphens', () => {
      expect(result).to.match(/.*--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--\s*$/);
    });
  });

  describe('.partial.emlx with filename without extension', () => {
    let result: string;

    before(async () => {
      const stream = new MemoryStream();
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/229417.partial.emlx'), stream);
      result = await streamToString(stream);
      writeForDebugging(result, '229417.eml');
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
      await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/11507.emlx'), stream, false);
      const result = await streamToString(stream);
      writeForDebugging(result, '11507.eml');
      expect(result).to.match(/^X-Antivirus: avg.*/);
      expect(result).to.match(/------=_NextPart_7ae48436ccb4c946256817a6c56cb01c--\n\n$/);
      expect(result.length).to.eql(3685);
    });
  });

  describe('SkipEmlxTransform', () => {
    // https://stackoverflow.com/questions/19906488/convert-stream-into-buffer
    it('small file', async () => {
      const fileStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-small.txt'));
      const resultStream = fileStream.pipe(new converter.SkipEmlxTransform());
      const result = await streamToString(resultStream);
      expect(result).to.eql('la\nle\nli');
    });

    it('large file', async () => {
      const readStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-large.txt'));
      const resultStream = readStream.pipe(new converter.SkipEmlxTransform());
      const result = await streamToString(resultStream);
      expect(result).to.match(/^ab.*/);
      expect(result).to.match(/.*bc$/);
      expect(result.length).to.eql(537723);
    });
  });

  it('throws error on invalid structure', async () => {
    try {
      await converter.processEmlx(path.join(__dirname, '__testdata/skip-emlx/invalid.emlx'), new MemoryStream());
    } catch (e) {
      expect(e.message).to.contain('Invalid structure; content did not start with payload length');
    }
  });
});

function extractHeader(input: string): string {
  return input.substring(0, input.indexOf('\r?\n\r?\n'));
}

function writeForDebugging(result: string, filename: string): void {
  if (debug) {
    fs.writeFileSync(path.join(os.homedir(), filename), result, 'utf-8');
  }
}

async function streamToString(readable: Readable, encoding = 'utf8'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const buffers: Buffer[] = [];
    readable.on('error', error => reject(error));
    readable.on('data', (b: Buffer) => buffers.push(b));
    readable.on('end', () => resolve(Buffer.concat(buffers).toString(encoding)));
  });
}
