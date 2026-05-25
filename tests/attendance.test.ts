import { describe, expect, it } from 'vitest';
import { calculateEquivalentAbsence, determineAttendanceStatus, getShiftWindow, isWithinAttendanceWindow } from '../src/shared/time';

describe('attendance rules', () => {
  it('treats check-ins before 10:15 PM PKT as present', () => {
    const status = determineAttendanceStatus(new Date('2026-05-22T17:10:00Z'));
    expect(status).toBe('Present');
  });

  it('treats check-ins after 10:15 PM PKT as late', () => {
    const status = determineAttendanceStatus(new Date('2026-05-22T17:20:00Z'));
    expect(status).toBe('Late');
  });

  it('returns false outside the scheduled shift window', () => {
    expect(isWithinAttendanceWindow(new Date('2026-05-22T12:00:00Z'))).toBe(false);
  });

  it('calculates equivalent absences from late counts', () => {
    expect(calculateEquivalentAbsence(0)).toBe(0);
    expect(calculateEquivalentAbsence(1)).toBe(0);
    expect(calculateEquivalentAbsence(2)).toBe(1);
    expect(calculateEquivalentAbsence(6)).toBe(3);
  });

  it('anchors the shift date to the overnight shift start', () => {
    const window = getShiftWindow(new Date('2026-05-22T17:10:00Z'));
    expect(window.shiftDate).toBe('2026-05-22');
  });
});