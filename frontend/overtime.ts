export type WeekStartDay = 'Mon';

type DateInput = Date | string;

const BASE_ACTIVE_MINUTES = 480;
const ACTIVE_NIGHT_CREDIT_CAP_MINUTES = 480;

function parseDateInput(date: DateInput): Date {
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  const [year, month, day] = date.split('-').map((value) => Number(value));
  if (!year || !month || !day) {
    throw new Error(`Invalid date input: ${date}`);
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function getWeekStart(date: DateInput, weekStartsOn: WeekStartDay): Date {
  const normalized = parseDateInput(date);
  const dayOfWeek = normalized.getUTCDay();

  if (weekStartsOn !== 'Mon') {
    throw new Error(`Unsupported week start: ${weekStartsOn}`);
  }

  const offset = (dayOfWeek + 6) % 7;
  const weekStart = new Date(normalized);
  weekStart.setUTCDate(weekStart.getUTCDate() - offset);

  return weekStart;
}

function toDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function calculateCreditedMinutesForNightShift(
  date: DateInput,
  nightActiveMinutes: number,
  forfaitMinutes = 0
): number {
  parseDateInput(date);

  const creditedActiveNightMinutes = Math.min(
    Math.max(0, nightActiveMinutes) * 2,
    ACTIVE_NIGHT_CREDIT_CAP_MINUTES
  );

  return BASE_ACTIVE_MINUTES + creditedActiveNightMinutes + Math.max(0, forfaitMinutes);
}

export function calculateWeeklyOvertime(
  creditedMinutesByDate: Record<string, number>,
  contractMinutesPerWeek: number,
  weekStartsOn: WeekStartDay
): number {
  const weekTotals = new Map<string, number>();

  Object.entries(creditedMinutesByDate).forEach(([dateKey, minutes]) => {
    const weekStart = getWeekStart(dateKey, weekStartsOn);
    const weekStartKey = toDateKey(weekStart);
    const currentTotal = weekTotals.get(weekStartKey) ?? 0;

    weekTotals.set(weekStartKey, currentTotal + Math.max(0, minutes));
  });

  let overtimeMinutes = 0;

  weekTotals.forEach((totalMinutes) => {
    const weeklyOvertime = Math.max(0, totalMinutes - contractMinutesPerWeek);
    overtimeMinutes += weeklyOvertime;
  });

  return overtimeMinutes;
}
