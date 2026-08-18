import { describe, expect, it } from 'bun:test';
import partsDatabase, { partsDatabase as namedPartsDatabase } from '../parts-database.js';
import { smartSearchV2 } from '../js/search-v2.js';
import { readFileSync } from 'node:fs';

describe('sanitized public showcase', () => {
  it('exposes the production database module contract with demo data', () => {
    expect(partsDatabase).toBe(namedPartsDatabase);
    expect(Object.keys(partsDatabase).length).toBe(12);
    expect(partsDatabase.DEMO001).toBe('Cabinet A, Drawer 1');
  });

  it('searches against demo data', () => {
    const exact = smartSearchV2('DEMO001', 3);
    expect(exact.exactMatch?.partNumber).toBe('DEMO001');
    expect(exact.exactMatch?.location).toBe('Cabinet A, Drawer 1');
  });

  it('precaches current runtime and generated database', () => {
    const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
    expect(sw).toContain('/parts-database.json');
    expect(sw).toContain('/js/order-mode.js');
    expect(sw).toContain('/js/voice-lookup.js');
  });
});
