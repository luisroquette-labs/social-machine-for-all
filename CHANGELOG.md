# Changelog

All notable changes to Social Machine for All are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-24

### Added

- Self-hosted content operations workspace covering discovery, curation, creation,
  review, publishing and learning.
- Workspace-scoped configuration for brand voice, sources, feature flags and
  platform credentials.
- Approval-first workflows with scheduled jobs and optional integrations disabled
  by default.
- Multi-channel foundations for Instagram, LinkedIn, X and YouTube, plus optional
  video, analytics, email and AI provider adapters.
- Supabase migrations, onboarding, public-release audit, automated tests and CI.
- Visual product tour, architecture overview, setup sequence and honest limitations.

### Security

- Removed bundled workspace and customer-specific defaults.
- Enforced workspace ownership in settings APIs.
- Updated Next.js to a security release.
- Added repository checks for credentials, sensitive exports and unsafe defaults.

### Validation

- Public-release audit.
- 873 automated tests across 119 files.
- ESLint and production build.
- Runtime dependency audit with no known high or critical vulnerabilities.

[0.1.0]: https://github.com/luisroquette-labs/social-machine-for-all/releases/tag/v0.1.0
