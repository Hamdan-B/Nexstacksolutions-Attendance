import { LATE_THRESHOLD, PKT_TIME_ZONE, SHIFT_END, SHIFT_START } from './constants';

function parseTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function toPktParts(date: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PKT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
}

export function pktDateString(date: Date): string {
  const parts = toPktParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function pktTimeString(date: Date): string {
  const parts = toPktParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

export function pktDateTimeString(date: Date): string {
  return `${pktDateString(date)} ${pktTimeString(date)}`;
}

export function getShiftWindow(now: Date): { shiftDate: string; startAt: Date; lateThresholdAt: Date; endAt: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PKT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '0');
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '1');
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '1');
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const currentMinutes = hour * 60 + minute;
  const shiftEndMinutes = parseTimeToMinutes(SHIFT_END);
  const utcOffsetHours = 5;
  const shiftDateParts = currentMinutes < shiftEndMinutes ? new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 24 * 60 * 60 * 1000) : now;
  const shiftDate = pktDateString(shiftDateParts);
  const shiftYear = Number(shiftDate.slice(0, 4));
  const shiftMonth = Number(shiftDate.slice(5, 7));
  const shiftDay = Number(shiftDate.slice(8, 10));
  const startAt = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay, SHIFT_START.startsWith('22') ? 17 : 17, 0, 0));
  const lateThresholdAt = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay, 17, 15, 0));
  const endAt = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay + 1, SHIFT_END.startsWith('06') ? 1 : 1, 0, 0));
  return { shiftDate, startAt, lateThresholdAt, endAt };
}

export function isWithinAttendanceWindow(now: Date): boolean {
  const { startAt, endAt } = getShiftWindow(now);
  return now >= startAt && now <= endAt;
}

export function determineAttendanceStatus(checkedInAt: Date): 'Present' | 'Late' | 'Absent' {
  const { startAt, lateThresholdAt, endAt } = getShiftWindow(checkedInAt);
  if (checkedInAt < startAt || checkedInAt > endAt) {
    return 'Absent';
  }
  return checkedInAt <= lateThresholdAt ? 'Present' : 'Late';
}

export function calculateEquivalentAbsence(lateCount: number): number {
  return Math.floor(Math.max(0, lateCount) / 2);
}

export function formatPktTimestamp(date: Date): string {
  return `${pktDateString(date)}T${pktTimeString(date)}+05:00`;
}