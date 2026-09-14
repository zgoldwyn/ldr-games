export type LegalDocumentId = 'privacy' | 'terms' | 'cookies' | 'refunds';

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface LegalDocument {
  readonly id: LegalDocumentId;
  readonly title: string;
  readonly summary: string;
  readonly effectiveDate: string;
  readonly sections: readonly LegalSection[];
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  privacy: {
    id: 'privacy',
    title: 'Privacy Policy',
    summary: 'What data the app needs, how it is used, and your choices.',
    effectiveDate: 'September 14, 2026',
    sections: [
      {
        heading: 'Information we process',
        paragraphs: [
          'We process your email, hashed authentication credentials, internal identifiers, and security/session information.',
          'When you use shared features, we process pairing status, game activity, and content you choose to submit. Optional push notifications use a device token after you grant permission.',
          'We do not currently use advertising, third-party analytics, tracking pixels, precise location, contacts, health data, or financial data.',
        ],
      },
      {
        heading: 'How and why we use it',
        paragraphs: [
          'We use information only to authenticate accounts, connect the partner you select, run and synchronize features, deliver requested notifications, prevent abuse, and keep the service reliable.',
          'Pairing content is available only to the two accounts in the active pairing. Ending a pairing revokes access to pairing-owned content.',
        ],
      },
      {
        heading: 'Providers',
        paragraphs: [
          'Supabase provides authentication, database, storage, realtime, logging, and server functions. Apple provides App Store distribution and APNs push delivery. We do not authorize either provider to use app data for our advertising.',
        ],
      },
      {
        heading: 'Retention and control',
        paragraphs: [
          'Undelivered notifications are retained for no more than 30 days. Other account and relationship information is retained while the account is active unless a shorter period applies.',
          'You can decline notifications, end a pairing, or permanently delete your account and associated content in Settings. Provider backups may age out on their secure retention schedule.',
        ],
      },
      {
        heading: 'Contact and pre-release notice',
        paragraphs: [
          'This is a pre-release policy. The operator legal name, private support email, address, production hosting region, and rights-request process must be published before release.',
          'LDR Companion is not directed to children under 13. If we learn that a child under 13 submitted personal information, we will delete it.',
        ],
      },
    ],
  },
  terms: {
    id: 'terms',
    title: 'Terms and Conditions',
    summary: 'Rules for accounts, pairing, content, and acceptable use.',
    effectiveDate: 'September 14, 2026',
    sections: [
      {
        heading: 'Agreement and eligibility',
        paragraphs: [
          'By creating an account, you agree to these Terms and acknowledge the Privacy Policy. You must be at least 13 and legally able to agree. The minimum launch age remains under review.',
        ],
      },
      {
        heading: 'Service and accounts',
        paragraphs: [
          'LDR Companion lets two people voluntarily pair accounts and use shared games and relationship tools for personal entertainment and organization. It is not counseling, medical, safety, emergency, or legal advice, and it does not promise a relationship outcome.',
          'Protect your credentials and share invitation codes only with the person you intend to pair with.',
        ],
      },
      {
        heading: 'Your content',
        paragraphs: [
          'You keep ownership of content you create and give us only the limited permission needed to host, transmit, display, secure, and support it.',
          'Do not submit content you cannot lawfully use, or content that is abusive, threatening, exploitative, infringing, or non-consensual.',
        ],
      },
      {
        heading: 'Account deletion',
        paragraphs: [
          'You can permanently delete your account in Settings. We may restrict access when reasonably necessary to protect users, comply with law, or address a material violation.',
        ],
      },
      {
        heading: 'Pre-release legal notice',
        paragraphs: [
          'The app currently has no paid purchases. Operator identity, governing law, consumer-rights, liability, dispute, and territory-specific language must be reviewed and completed before public release.',
        ],
      },
    ],
  },
  cookies: {
    id: 'cookies',
    title: 'Cookie Policy',
    summary: 'The app uses no cookies or optional tracking technologies today.',
    effectiveDate: 'September 14, 2026',
    sections: [
      {
        heading: 'Current app',
        paragraphs: [
          'The native app does not use browser cookies, advertising identifiers, third-party analytics, tracking pixels, fingerprinting, or third-party embeds.',
          'It stores the secure authentication session, a local game cache, and your selected theme. An APNs device token is stored only after you enable push notifications.',
        ],
      },
      {
        heading: 'Consent decision',
        paragraphs: [
          'There is no cookie banner because the current app sets no non-essential cookies or tracking storage. A banner asking for consent when nothing optional is loaded would be misleading.',
          'Before analytics, advertising, embeds, pixels, session replay, or other optional storage is added, this policy and the App Store disclosures must be updated and the technology must remain off until legally required consent is obtained.',
        ],
      },
    ],
  },
  refunds: {
    id: 'refunds',
    title: 'Refund Policy',
    summary: 'The current app has no purchases or subscriptions.',
    effectiveDate: 'September 14, 2026',
    sections: [
      {
        heading: 'Current app',
        paragraphs: [
          'LDR Companion currently has no paid purchases, subscriptions, or direct payment collection, so there is currently nothing to refund.',
        ],
      },
      {
        heading: 'Future purchases',
        paragraphs: [
          'Before adding paid features, we must disclose price, renewal, cancellation, and refund terms before purchase. Apple-processed purchases use Apple’s refund process and remain subject to applicable consumer law.',
          'Deleting an account does not automatically cancel an App Store subscription. If subscriptions are introduced, the deletion flow will explain cancellation before deletion.',
        ],
      },
    ],
  },
};

export const LEGAL_DOCUMENT_ORDER: readonly LegalDocumentId[] = [
  'privacy',
  'terms',
  'cookies',
  'refunds',
];
