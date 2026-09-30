import { describe, expect, it } from 'vitest';
import { dateId, pairingId, type CalendarDate, type RelationshipDate } from '@ldr/core';

import { ANNIVERSARY_TITLE, buildImportantMilestones, elapsedDays } from './important-dates';

function relationshipDate(title: string, date: CalendarDate): RelationshipDate {
  return {
    id: dateId(title),
    pairingId: pairingId('pair'),
    title,
    date,
    recurring: true,
  };
}

describe('important relationship dates', () => {
  it('derives the together count from the anniversary calendar date', () => {
    expect(elapsedDays({ year: 2026, month: 9, day: 14 }, { year: 2026, month: 9, day: 29 })).toBe(
      15,
    );
  });

  it('includes monthly and fifty-day milestones in chronological order', () => {
    const milestones = buildImportantMilestones({
      dates: [relationshipDate(ANNIVERSARY_TITLE, { year: 2026, month: 1, day: 31 })],
      selfName: 'Micah',
      partnerName: 'Zach',
      today: { year: 2026, month: 2, day: 1 },
      limit: 8,
    });

    expect(milestones.some((milestone) => milestone.label.includes('1 month together'))).toBe(true);
    expect(milestones.some((milestone) => milestone.label.includes('50 days together'))).toBe(true);
    expect(milestones.map((milestone) => milestone.daysAway)).toEqual(
      [...milestones.map((milestone) => milestone.daysAway)].sort((a, b) => a - b),
    );
  });

  it('clamps a monthly landmark to the end of a shorter month', () => {
    const milestones = buildImportantMilestones({
      dates: [relationshipDate(ANNIVERSARY_TITLE, { year: 2026, month: 1, day: 31 })],
      selfName: 'Micah',
      partnerName: 'Zach',
      today: { year: 2026, month: 2, day: 1 },
      limit: 8,
    });
    expect(milestones).toContainEqual(
      expect.objectContaining({
        date: { year: 2026, month: 2, day: 28 },
        label: expect.stringContaining('1 month together'),
      }),
    );
  });
});
