import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENTS } from './legal-content';

describe('in-app legal content', () => {
  it('keeps every required policy available in the legal center', () => {
    expect(LEGAL_DOCUMENT_ORDER).toEqual(['privacy', 'terms', 'cookies', 'refunds']);

    for (const id of LEGAL_DOCUMENT_ORDER) {
      const document = LEGAL_DOCUMENTS[id];
      expect(document.id).toBe(id);
      expect(document.title).not.toHaveLength(0);
      expect(document.effectiveDate).toBe('September 14, 2026');
      expect(document.sections.length).toBeGreaterThan(0);
      expect(document.sections.every((section) => section.paragraphs.length > 0)).toBe(true);
    }
  });

  it('states the current no-tracking and no-purchase positions', () => {
    const cookies = LEGAL_DOCUMENTS.cookies.sections.flatMap((section) => section.paragraphs);
    const refunds = LEGAL_DOCUMENTS.refunds.sections.flatMap((section) => section.paragraphs);

    expect(cookies.join(' ')).toContain('does not use browser cookies');
    expect(cookies.join(' ')).toContain('no cookie banner');
    expect(refunds.join(' ')).toContain('no paid purchases');
  });
});
