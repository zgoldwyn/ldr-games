# Legal, Privacy, Accessibility, and Trust Action Plan

**Audit date:** September 14, 2026

**Scope:** Current repository and planned iOS MVP. This is an engineering and
product risk review, not legal advice.

## Current findings

- No advertising, application analytics, crash reporting, tracking, session
  replay, third-party embeds, testimonials, or fake reviews were found.
- The app processes email, identifiers, session/security records, pairing and game
  data, optional push tokens, and future drawings/quiz/calendar content.
- Supabase and Apple/APNs are the current processors/platform providers.
- Account deletion exists in Settings and removes application, authentication,
  pairing, and Storage data through the tested deletion flow.
- The privacy policy did not provide final operator contact details, a private
  rights-request channel, international-transfer detail, or an in-app legal center.
- The only bundled images are the app icon and splash image. Git records who added
  them but contains no source/license record, so provenance is not proven.
- All five palettes fail WCAG contrast for muted/error text and low-contrast form
  boundaries. These tokens are an immediate remediation item.
- Forms use native inputs and keyboard avoidance, but need explicit accessible
  labels, next/done keyboard flow, error announcements, and registration clickwrap.

## Cookie-consent decision

No cookie banner is required for the current native build: it has no browser
cookies or non-essential tracking/storage. Authentication storage and the local
game cache are necessary to provide the signed-in service; the theme is a
user-requested preference; push is permission-gated. Reassess before shipping any
web app, analytics, embed, pixel, advertising SDK, fingerprinting, or session
replay. EU/EEA guidance generally requires consent before non-essential cookies
or similar storage, while strictly necessary storage is exempt.

## Applicable-law launch gates

| Area                          | Current assessment                                                                         | Required action                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple App Review              | Applies to iOS distribution                                                                | Keep Privacy accessible in-app and in metadata; retain in-app deletion; provide two review accounts; verify disclosures against the binary                 |
| California CalOPPA            | Likely applies if the service collects email from California users                         | Publish a conspicuous privacy policy with categories, sharing, request method, effective date, and tracking/DNT disclosure                                 |
| California CCPA/CPRA          | Threshold-dependent; the current project is likely below them, but facts must be confirmed | Record annual revenue, California volume, and sale/share status yearly; implement statutory notices/rights if a threshold is met                           |
| Other U.S. state privacy laws | Depends on users, volume, revenue, and data practices                                      | Build a launch-territory matrix with counsel before broad U.S. availability                                                                                |
| FTC Act / reviews             | Applies to U.S. marketing                                                                  | Substantiate objective claims before publication; never create/buy fake reviews; disclose material connections                                             |
| COPPA                         | Applies if directed to under-13s or there is actual knowledge                              | Keep the service non-child-directed; choose 13+ versus 18+; establish deletion handling for discovered under-13 accounts                                   |
| GDPR / ePrivacy               | Applies if the service targets people in the EEA                                           | Confirm target territories, lawful bases, rights workflow, processor/DPA terms, hosting/transfers, retention, EU representative need, and consent controls |
| UK GDPR / PECR                | Applies if targeting UK users                                                              | Perform the same launch review; treat app storage/SDK identifiers as similar technologies, not only browser cookies                                        |
| Consumer/refund law           | Applies when selling paid features                                                         | Keep the current “no purchases” policy; review price/renewal/cancellation/refund disclosures before monetization                                           |
| Accessibility                 | App Store quality issue and potential legal exposure varies by territory/use               | Target WCAG 2.2 AA principles plus VoiceOver/Dynamic Type/native mobile testing; obtain counsel for market-specific duties                                 |
| Copyright/trademark           | Applies to code, artwork, copy, and user content                                           | Record license/source for every asset and dependency; use original/licensed artwork; create an infringement contact and takedown process                   |

The CCPA currently applies to qualifying for-profit businesses that meet at least
one threshold, including $26.625 million annual gross revenue (2025-adjusted),
buying/selling/sharing data of 100,000 California residents/households, or deriving
50% of revenue from selling/sharing personal information. CalOPPA is broader and
can apply to an online service collecting identifiable information such as email
from California users.

## Action items

### Completed in the initial pass

- [x] Add Privacy, Terms, Cookie, and Refund drafts in `docs/`.
- [x] Add an in-app legal center reachable before account creation and in Settings.
- [x] Add an unchecked registration agreement with direct Terms and Privacy links.
- [x] Add native next/done keyboard flow, accessible field names, minimum control
      sizes, and live error announcements to the authentication form/components.
- [x] Add a motion-free, layout-preserving boot skeleton that is hidden from the
      accessibility tree behind one concise loading announcement.
- [x] Add automated WCAG contrast assertions and correct normal text, error text,
      and essential component-boundary colors across all five palettes.
- [x] Add accessible names, roles, disabled states, and outcomes to tic-tac-toe
      and Battleship grid controls.

### P0 — before any public release

- [ ] Supply and publish operator legal name, business/mailing address, country,
      monitored support email, and privacy-request email. Do not use a public GitHub
      issue for personal requests.
- [ ] Confirm launch territories, business entity, intended minimum age, whether
      the service targets EEA/UK users, and whether any payment/subscription is planned.
- [ ] Have qualified counsel review the policies and tailor governing law,
      consumer rights, liability, dispute, minors, and international-transfer terms.
- [ ] Host stable public URLs for Privacy, Terms, Cookie, and Refund policies;
      link Privacy in App Store metadata and all policies in-app.
- [ ] Complete registration clickwrap: unchecked by default, Terms agreement and
      Privacy acknowledgement separately named, with policy links available before
      account creation; store policy versions and acceptance timestamps.
- [ ] Remediate palette contrast and test normal text at 4.5:1, large text and
      essential UI boundaries at 3:1; test Increase Contrast and Reduce Transparency.
- [ ] Run VoiceOver, Switch Control, keyboard, and Dynamic Type through every core
      flow; provide accessible names/roles/states and announce validation errors.
- [ ] Record provenance/license for `icon.png` and `splash.png`; replace either if
      the creator/license cannot be documented. Add `docs/asset-register.md`.
- [ ] Verify the shipped binary and Supabase project still contain no unreported
      analytics/tracking SDKs; update App Store privacy labels after every dependency
      or backend change.
- [ ] Decide 13+ versus 18+, align App Store age rating and Terms, and document the
      response if an underage user is discovered.

### P1 — before beta distribution

- [ ] Add a data-retention schedule for every database table, Auth log, Storage
      object, infrastructure log, and backup; automate deletion where promised.
- [ ] Add a private, authenticated data access/export/correction request flow and
      an internal response-verification procedure.
- [ ] Execute and archive Supabase processor terms/DPA; record production region,
      subprocessors, breach contact, and international-transfer mechanism.
- [ ] Create an incident-response plan, security contact, dependency-patching
      cadence, and user breach-notification decision tree.
- [ ] Add a content-reporting and safety escalation path for abusive,
      non-consensual, exploitative, or infringing paired content.
- [ ] Expand skeleton states beyond app boot to delayed game/session fetches; keep
      them layout-preserving, motion-safe, and hidden from assistive technologies.
- [ ] Replace custom top primary navigation with a native mobile tab pattern;
      preserve route names and avoid animated peer-to-peer tab transitions.

### P2 — before monetization, analytics, or marketing expansion

- [ ] Run a claim register: every objective marketing statement needs dated
      evidence and an owner. Do not claim relationship, health, or wellbeing outcomes.
- [ ] If displaying reviews, retain proof of real experience, disclose incentives
      and insider relationships, do not condition incentives on sentiment, and never
      suppress reviews deceptively.
- [ ] Before analytics/session replay/ads, document necessity, vendor terms,
      events/fields, retention, user controls, privacy labels, and consent requirements;
      default to not adding them.
- [ ] Before third-party embeds, assess cookies/network requests, provide a
      privacy-preserving placeholder, and load only after required consent.
- [ ] Before payments, update Terms/Refund policy and deletion UI for subscription
      cancellation; test Apple's refund/subscription-management handoffs.
- [ ] Introduce claymorphism only through accessible semantic tokens: restrained
      dual shadows, solid-enough surfaces, 3:1 component boundaries, no meaning by
      shadow alone, Reduce Transparency fallback, and device performance testing.

## Source baseline

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app)
- [California Privacy Protection Agency CCPA FAQ](https://cppa.ca.gov/faq)
- [California DOJ CalOPPA guidance](https://oag.ca.gov/privacy/caloppa)
- [FTC COPPA guidance](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)
- [FTC reviews and testimonials rule](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- [FTC advertising substantiation policy](https://www.ftc.gov/legal-library/browse/ftc-policy-statement-regarding-advertising-substantiation)
- [European Commission GDPR scope](https://commission.europa.eu/law/law-topic/data-protection/reform/rules-business-and-organisations/application-regulation/who-does-data-protection-law-apply_en)
- [EDPB cookie consent FAQ](https://www.edpb.europa.eu/sme/find-practical-info/faq_en)
- [ICO cookies guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [U.S. Copyright Office photography guidance](https://www.copyright.gov/engage/photographers/)
