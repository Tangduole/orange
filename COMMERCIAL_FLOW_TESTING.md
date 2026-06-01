# Commercial Flow Testing

This guide covers the payment-ready commercial flow before enabling a live checkout provider.

## 1. Required Runtime

Use real production-like services for the flow you want to validate:

- `JWT_SECRET`
- `DOWNLOAD_URL_SECRET`
- `AI_API_URL`, `AI_API_KEY`, `AI_MODEL`
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` or a local `LOCAL_DB_PATH`
- Platform provider keys needed by the target download platforms

Payment provider keys can remain unset until checkout is enabled.

## 2. Create A Test Pro Account

There is no public admin-key endpoint. For pre-payment testing, prefer a payment-provider sandbox checkout. If checkout is not enabled yet, update a single test account directly in the database from a trusted shell:

```sql
UPDATE users
SET tier = 'pro',
    subscription_status = 'active',
    subscription_ends_at = unixepoch() + 30 * 24 * 60 * 60
WHERE email = 'test@example.com';
```

The same account then uses the normal frontend login and runs the real Pro flow:

- Unlimited download quota.
- High quality/original quality gates.
- Batch download.
- AI copywriting.
- Material library favorites/tags/notes.
- Signed download links.
- Pro file retention.

## 3. Smoke Checks

The smoke script is for fast regression checks only. It does not replace the real member account flow.

```bash
cd backend
npm run smoke
```

It verifies:

- Platform hostname validation.
- Signed download URL generation and verification.
- AI entitlement and retention helpers.
- Browser extension manifest JSON.

## 4. Payment Cutover

After the Pro test account flow is verified, connect payment by configuring either Lemon Squeezy or Creem. The checkout and webhook routes update the same user subscription fields used by the test account, so feature gates do not need a second implementation.
