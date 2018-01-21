import 'mocha';
import * as path from 'path';
import * as converter from '../src/converter';

describe('converter', () => {

  let result;

  before(async () => {
    result = await converter.processEmlx(path.join(__dirname, '__testdata/Messages/123456.partial.emlx'));
  });

  it('print result', () => {
    console.log(result);
  });

});
