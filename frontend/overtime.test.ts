import {
  calculateCreditedMinutesForNightShift,
  calculateWeeklyOvertime,
} from './overtime';

type TestCallback = () => void;

function describe(name: string, callback: TestCallback): void {
  console.log(`\\n${name}`);
  callback();
}

function it(name: string, callback: TestCallback): void {
  try {
    callback();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function expectEqual(actual: number, expected: number, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

describe('calculateCreditedMinutesForNightShift', () => {
  const date = '2024-05-06';

  it('returns base credited minutes when no active night work', () => {
    expectEqual(calculateCreditedMinutesForNightShift(date, 0), 480, 'case A');
  });

  it('adds doubled active night minutes', () => {
    expectEqual(calculateCreditedMinutesForNightShift(date, 30), 540, 'case B');
  });

  it('adds doubled active night minutes for extended work', () => {
    expectEqual(calculateCreditedMinutesForNightShift(date, 120), 720, 'case C');
  });

  it('caps credited active night minutes at 480 after doubling', () => {
    expectEqual(calculateCreditedMinutesForNightShift(date, 360), 960, 'case D');
  });

  it('adds forfait minutes to the base credit', () => {
    expectEqual(calculateCreditedMinutesForNightShift(date, 0, 15), 510, 'case E');
  });
});

describe('calculateWeeklyOvertime', () => {
  it('returns weekly overtime based on Monday week start', () => {
    const creditedMinutesByDate = {
      '2024-05-06': 480,
      '2024-05-07': 480,
      '2024-05-08': 480,
      '2024-05-09': 480,
      '2024-05-10': 480,
    };

    expectEqual(calculateWeeklyOvertime(creditedMinutesByDate, 2160, 'Mon'), 240, 'weekly');
  });

  it('handles shifts that cross midnight by grouping by start date week', () => {
    const creditedMinutesByDate = {
      '2024-05-05': 480,
      '2024-05-06': 480,
    };

    expectEqual(calculateWeeklyOvertime(creditedMinutesByDate, 960, 'Mon'), 0, 'cross-midnight');
  });
});
