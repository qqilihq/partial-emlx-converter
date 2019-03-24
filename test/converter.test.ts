import expect = require('expect.js');
import 'mocha';
import * as path from 'path';
import * as converter from '../src/converter';
import * as fs from 'fs';
import * as os from 'os';

/** enable to write results to home dir. */
const debug = false;

describe('converter', () => {

  describe('.partial.emlx (contains external attachments)', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114892.partial.emlx'));
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

    it('result has 2171 lines', () => {
      // one line less in generated eml, b/c of different quoted-printable encoding
      expect(result.split('\n').length).to.eql(2171);
    });

    it('headers are equal', () => {
      const resultHeader = extractHeader(result);
      const expectedHeader = extractHeader(expectedResult);
      expect(resultHeader).to.eql(expectedHeader);
    });

    it('only CR-LF line endings', () => {
      // remove all CR-LF sequences, and then check whether
      // there are lonesome LF characters left (fail)
      const tempResultWithoutCrLf = result.replace(/\r\n/g, '');
      expect(tempResultWithoutCrLf.includes('\n')).to.be(false);
    });

    it('boundaries are at expected lines', () => {
      const tempLines = result.split(/\r?\n/);
      expect(tempLines[19]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
      expect(tempLines[92]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
      expect(tempLines[113]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[158]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[634]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[699]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      // from here, offset -1 compared to original because
      // of different quoted-printable encoding
      expect(tempLines[739]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[816]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[2141]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
      expect(tempLines[2167]).to.eql('--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886--');
      expect(tempLines[2169]).to.eql('--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--');
    });

  });

  describe('.emlx', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114862.emlx'));
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

  describe('.partial.emlx with missing attachment file -- #3', () => {

    // https://github.com/qqilihq/partial-emlx-converter/issues/3
    it('fails per default', async () => {
      try {
        await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'), false);
        expect().fail();
      } catch (e) {
        expect(e.code).to.eql('ENOENT');
      }
    });

    it('does not fail when flag is set', async () => {
      try {
        const result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'), true);
        writeForDebugging(result, '114863.eml');
      } catch (e) {
        expect().fail();
      }
    });

  });

  describe('.partial.emlx with attachments without given filename -- #3', () => {

    let result: string;

    before(async () => {
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114894.partial.emlx'));
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
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114895.partial.emlx'), true);
      writeForDebugging(result, '114895.eml');
    });

    it('fixes end boundary string with one hyphen to two hyphens', () => {
      expect(result).to.match(/.*--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--\s*$/);
    });

  });

});

function extractHeader (input: string): string {
  return input.substring(0, input.indexOf('\r\n\r\n'));
}

function writeForDebugging (result: string, filename: string) {
  if (debug) {
    fs.writeFileSync(path.join(os.homedir(), filename), result, 'utf-8');
  }
}
