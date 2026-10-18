import { expect, it } from 'vitest';
import { flateBombPdf, streamedFlateBombPdf } from '../src/hostile-fixtures.js';

it.each([0, 1, 4])('preserves the exact %i MiB Flate fixture when streamed', async (megabytes) => {
  expect(await streamedFlateBombPdf(megabytes)).toEqual(flateBombPdf(megabytes));
});
