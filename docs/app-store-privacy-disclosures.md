# App Store Privacy Disclosures

Use these answers when completing App Store Connect's App Privacy questionnaire.
They describe the current app and must be reviewed again whenever data handling
or third-party services change.

## Tracking and advertising

- Data used to track users: **No**
- Third-party advertising: **No**
- Data sold to data brokers or other parties: **No**

## Data linked to the user

| App Store data type               | Examples in LDR Companion                                                  | Purpose                               |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| Contact Info → Email Address      | Sign-in email                                                              | App Functionality; Account Management |
| User Content → Photos or Videos   | Images created or uploaded by the user                                     | App Functionality                     |
| User Content → Other User Content | Game activity, quiz responses, relationship dates, reminders, and drawings | App Functionality                     |
| Identifiers → User ID             | Internal account and pairing identifiers                                   | App Functionality; Account Management |
| Identifiers → Device ID           | Native APNs device token                                                   | App Functionality                     |

For every row above:

- Linked to the user's identity: **Yes**
- Used for tracking: **No**

## Data not collected

The current app does not include advertising SDKs, third-party analytics,
location collection, contacts access, health data, financial data, browsing
history, search history, or sensitive-info profiling.

Supabase may retain limited infrastructure logs needed for security and service
operation. Re-evaluate the questionnaire before submission if application-level
analytics, crash reporting, customer support tooling, or another SDK is added.

## Review checklist

- Confirm these answers still match the shipped binary and production backend.
- Use the public URL for `docs/privacy-policy.md` as the Privacy Policy URL.
- State in review notes that two pre-paired demo accounts are available and that
  their passwords are stored in the developer's macOS Keychain.
- Verify **Settings → Delete account** works in the review build.
