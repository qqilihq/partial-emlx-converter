import 'npm:mocha@10.2.0';
import * as path from 'node:path';
import * as converter from '../src/converter.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import MemoryStream from 'npm:memorystream@0.3.1'
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { assertEquals, assertStringIncludes, assertArrayIncludes, assertMatch } from 'https://deno.land/std@0.204.0/assert/mod.ts';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** enable to write results to home dir. */
const debug = false;

Deno.test('.partial.emlx (contains external attachments)', async () => {
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114892.partial.emlx'), stream);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  const expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114892.eml'), 'utf-8');
  writeForDebugging(buffer, '114892.eml');

  // 'glücklichen' gets encoded to the following value
  assertStringIncludes(result, 'gl=C3=BCcklichen', 'encodes quoted-printable in text.txt attachment');

  assertStringIncludes(result, 'iVBORw0KGgoAAAANSUhE', 'encodes base64 in image001.png attachment');

  assertStringIncludes(result, 'Short text.', 'encodes 7bit in short.txt attachment');

  // three lines less in generated eml, b/c of different quoted-printable encoding
  assertEquals(result.split('\n').length, 2169, 'result has 2169 lines');

  const resultHeader = extractHeader(result);
  const expectedHeader = extractHeader(expectedResult);
  assertEquals(resultHeader, expectedHeader, 'headers are equal');

  // boundaries are at expected lines
  const tempLines = result.split(/\r?\n/);
  assertEquals(tempLines[19], '--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
  assertEquals(tempLines[92], '--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B');
  assertEquals(tempLines[112], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[157], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[633], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[698], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  // from here, offset -1 compared to original because
  // of different quoted-printable encoding
  assertEquals(tempLines[737], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[814], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[2139], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886');
  assertEquals(tempLines[2165], '--Apple-Mail=_199BBC0B-37DE-426E-862E-2207565E5886--');
  assertEquals(tempLines[2167], '--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--');
});

Deno.test('.emlx', async () => {
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114862.emlx'), stream);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  const expectedResult = fs.readFileSync(path.join(__dirname, '__testdata/expected_results/114862.eml'), 'utf-8');
  writeForDebugging(buffer, '114862.eml');

  assertEquals(result.split('\n').length, 61, 'result has 61 lines');

  assertEquals(result, expectedResult, 'exactly equals the expected result');
});

Deno.test('issue 1', async () => {
  // https://github.com/qqilihq/partial-emlx-converter/issues/1
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/465622.partial.emlx'), stream);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  writeForDebugging(buffer, '465622.emlx');

  assertEquals(result.split('\n').length > 2000, true, 'result has more than 2000 lines');
});

Deno.test('.partial.emlx with missing attachment file -- #3', { sanitizeOps: false, sanitizeResources: false }, async (t) => {
  // https://github.com/qqilihq/partial-emlx-converter/issues/3

  await t.step('fails per default', async () => {
    try {
      await converter.processEmlx(
        path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
        new MemoryStream(),
        false
      );
      assertEquals(true, false);
    } catch (e) {
      assertStringIncludes((e as Error).message, 'Could not get attachment file');
    }
  });

  await t.step('does not fail when flag is set', async () => {
    try {
      const stream = new MemoryStream();
      const messages = await converter.processEmlx(
        path.join(__dirname, '__testdata/input/Messages/114893.partial.emlx'),
        stream,
        true
      );
      assertEquals(messages.length, 4);
      assertArrayIncludes(messages, [
        'Could not get attachment file (tried short.txt)',
        'Could not get attachment file (tried original.doc)',
        'Could not get attachment file (tried text.txt)',
        'Could not get attachment file (tried image001.png)'
      ]);
      const buffer = await streamToBuffer(stream);
      writeForDebugging(buffer, '114863.eml');
    } catch (_e) {
      assertEquals(true, false);
    }
  })
});

Deno.test('partial.emlx with attachments without given filename -- #3', async () => {
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114894.partial.emlx'), stream);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  writeForDebugging(buffer, '114894.eml');

  assertStringIncludes(result, 'iVBORw0KGgoAAAANSUhE', 'encodes base64 in image001.png attachment');
});

Deno.test('.partial.emlx with missing line break after boundary string -- #5', async () => {
  // actually, this fix is about correcting an invalid end boundary string;
  // according to the specification, it should be: close-delimiter := delimiter "--",
  // however, the test data used only a single hyphen, which caused parsing errors
  // https://github.com/qqilihq/partial-emlx-converter/issues/5

  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/114895.partial.emlx'), stream, true);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  writeForDebugging(buffer, '114895.eml');

  assertMatch(result, /.*--Apple-Mail=_F073CB14-2AA7-40E0-88F6-8C1A8748438B--\s*$/, 'fixes end boundary string with one hyphen to two hyphens');
});

Deno.test('.partial.emlx with filename without extension', async () => {
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/229417.partial.emlx'), stream);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  writeForDebugging(buffer, '229417.eml');

  assertStringIncludes(result, 'iVBORw0KGgoAAAANSUhE', 'contains encoded attachment');
});

Deno.test('different boundary strings -- #10', async () => {
  // https://github.com/qqilihq/partial-emlx-converter/issues/10
  // used to throw error before,
  // but since switching to `mailsplit`,
  // this is handled gracefully
  const stream = new MemoryStream();
  await converter.processEmlx(path.join(__dirname, '__testdata/input/Messages/11507.emlx'), stream, false);
  const buffer = await streamToBuffer(stream);
  const result = buffer.toString('utf8');
  writeForDebugging(buffer, '11507.eml');
  assertMatch(result, /^X-Antivirus: avg.*/);
  assertMatch(result,/------=_NextPart_7ae48436ccb4c946256817a6c56cb01c--\n\n$/);
  assertEquals(result.length, 3685);
});

Deno.test('SkipEmlxTransform', async (t) => {
  // https://stackoverflow.com/questions/19906488/convert-stream-into-buffer
  await t.step('small file', async () => {
    const fileStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-small.txt'));
    const resultStream = fileStream.pipe(new converter.SkipEmlxTransform());
    const buffer = await streamToBuffer(resultStream);
    assertEquals(buffer.toString('utf8'),'la\nle\nli');
  });

  await t.step('large file', async () => {
    const readStream = fs.createReadStream(path.join(__dirname, '__testdata/skip-emlx/test-large.txt'));
    const resultStream = readStream.pipe(new converter.SkipEmlxTransform());
    const buffer = await streamToBuffer(resultStream);
    const result = buffer.toString('utf8');
    assertMatch(result, /^ab.*/);
    assertMatch(result,/.*bc$/);
    assertEquals(result.length,537723);
  });
})

Deno.test('throws error on invalid structure',  {sanitizeOps: false, sanitizeResources: false }, async () => {
      try {
      await converter.processEmlx(path.join(__dirname, '__testdata/skip-emlx/invalid.emlx'), new MemoryStream());
      assertEquals(true, false);
    } catch (e) {
      assertStringIncludes((e as Error).message, 'Invalid structure; content did not start with payload length');
    }
});

Deno.test('message with Latin 1 encoding -- #17', async () => {
  // https://github.com/qqilihq/partial-emlx-converter/issues/17
  const testFile = path.join(__dirname, '__testdata/encrypted/258310/Messages/258310.partial.emlx');
  if (!fs.existsSync(testFile)) {
    // https://mochajs.org/#inclusive-tests
    return; // skip
  }
  const stream = new MemoryStream();
  await converter.processEmlx(testFile, stream);
  const buffer = await streamToBuffer(stream);
  // nb: deliberately use 'binary' and not 'utf8' here
  // https://stackoverflow.com/a/40775633/388827
  const result = buffer.toString('binary');
  writeForDebugging(buffer, '258310.eml');
  const expectedResult = fs.readFileSync(
    path.join(__dirname, '__testdata/encrypted/258310/expected_results/258310.eml'),
    'binary'
  );

  // properly preserves accented characters
  assertStringIncludes(result, '-------- Message transféré --------');
  assertStringIncludes(result, 'Délégation');

  // exactly equals the expected result
  assertEquals(result, expectedResult);
});

function extractHeader(input: string): string {
  return input.substring(0, input.indexOf('\r?\n\r?\n'));
}

function writeForDebugging(result: Buffer, filename: string): void {
  if (debug) {
    fs.writeFileSync(path.join(os.homedir(), filename), result);
  }
}

function streamToBuffer(readable: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const buffers: Buffer[] = [];
    readable.on('error', error => reject(error));
    readable.on('data', (b: Buffer) => buffers.push(b));
    readable.on('end', () => resolve(Buffer.concat(buffers)));
  });
}
