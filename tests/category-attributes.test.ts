/**
 * BV-038: the "no year beyond today" bound on Vehicles.year / Art.yearCreated used to be
 * baked in from `new Date().getFullYear()` read once at module import time, so a long-lived
 * process would keep enforcing whatever year it happened to start in, forever. The fix reads
 * the clock inside validateCategoryAttributes on every call instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCategoryAttributes } from '../src/modules/listings/category-attributes.js';

describe('validateCategoryAttributes — year bound tracks the real calendar (BV-038)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-evaluates the max year on every call instead of freezing it at import time', () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date('2027-06-15T00:00:00Z'));
    expect(
      validateCategoryAttributes('Vehicles', { make: 'Toyota', model: 'Corolla', year: 2027, mileage: 1000 }).success,
    ).toBe(true);

    // The process stays alive across a year boundary. A module-load-time bound would still
    // be whatever year this test file was first imported in and would reject both of these.
    vi.setSystemTime(new Date('2028-01-05T00:00:00Z'));
    expect(
      validateCategoryAttributes('Vehicles', { make: 'Toyota', model: 'Corolla', year: 2028, mileage: 1000 }).success,
    ).toBe(true);
    expect(
      validateCategoryAttributes('Vehicles', { make: 'Toyota', model: 'Corolla', year: 2029, mileage: 1000 }).success,
    ).toBe(false);
  });

  it('applies the same fresh bound to Art & Collectibles.yearCreated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-03-01T00:00:00Z'));

    expect(
      validateCategoryAttributes('Art & Collectibles', {
        creator: 'A Painter',
        medium: 'Oil on canvas',
        yearCreated: 2030,
      }).success,
    ).toBe(true);
    expect(
      validateCategoryAttributes('Art & Collectibles', {
        creator: 'A Painter',
        medium: 'Oil on canvas',
        yearCreated: 2031,
      }).success,
    ).toBe(false);
  });
});
