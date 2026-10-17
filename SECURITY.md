# Security policy

Never commit `.env` files, credentials, database exports or platform tokens.
Each installation must use its own Supabase project, deployment and credentials.

Before publishing a fork, run `npm run audit:public-release`.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/luisroquette-labs/social-machine-for-all/security/advisories/new).
Do not open a public issue or include a usable secret, token, customer record or
credential in a report.

This community project is provided without a support SLA. If a credential may
have been exposed, revoke and rotate it immediately instead of waiting for a
maintainer response.
