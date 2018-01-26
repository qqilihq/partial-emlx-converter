import * as expect from 'expect.js';
import 'mocha';
import * as path from 'path';
import * as converter from '../src/converter';
import * as fs from 'fs';
import * as os from 'os';

describe('converter', () => {

  /** enable to write results to home dir. */
  const debug = false;

  describe('.partial.emlx (contains external attachments)', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114858.partial.emlx'));
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114858.eml'), 'utf-8');
      if (debug) {
        fs.writeFileSync(path.join(os.homedir(), '114858.eml'), result, 'utf-8');
      }
    });

    it('encodes quoted-printable in text.txt attachment', () => {
      // 'glücklichen' gets encoded to the following value
      expect(result).to.contain('gl=C3=BCcklichen');
    });

    it('encodes base64 in image001.png attachment', () => {
      expect(result).to.contain('iVBORw0KGgoAAAANSUhE');
    });

    it('result has 2077 lines', () => {
      expect(result.split('\n').length).to.eql(2077);
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
      expect(tempResultWithoutCrLf.indexOf('\n')).to.eql(-1);
    });

    it('boundaries are at expected lines', () => {
      const tempLines = result.split(/\r?\n/);
      expect(tempLines[19]).to.eql('--Apple-Mail=_DF3287E9-4C39-45B0-A7DB-37F217F38047');
      expect(tempLines[79]).to.eql('--Apple-Mail=_DF3287E9-4C39-45B0-A7DB-37F217F38047');
      expect(tempLines[84]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[90]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[566]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[626]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[667]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[740]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[2065]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF');
      expect(tempLines[2073]).to.eql('--Apple-Mail=_152592B6-E63D-4BAC-A23C-2EA3614823AF--');
      expect(tempLines[2075]).to.eql('--Apple-Mail=_DF3287E9-4C39-45B0-A7DB-37F217F38047--');
    });

  });

  describe('.emlx', () => {
    let result: string;
    let expectedResult: string;

    before(async () => {
      result = await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114862.emlx'));
      expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114862.eml'), 'utf-8');
      if (debug) {
        fs.writeFileSync(path.join(os.homedir(), '114862.eml'), result, 'utf-8');
      }
    });

    it('result has 61 lines', () => {
      expect(result.split('\n').length).to.eql(61);
    });

    it('exactly equals the exptected result', () => {
      expect(result).to.eql(expectedResult);
    });

  });

});

function extractHeader (input: string): string {
  return input.substring(0, input.indexOf('\r\n\r\n'));
}
