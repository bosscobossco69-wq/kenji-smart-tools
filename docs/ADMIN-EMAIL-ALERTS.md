# KENJI Administrator Email Alerts

Email notifications are created for website service payments, website intake forms, successfully credited Credits purchases, paid subscription invoices, and actionable Stripe/website server errors. Only limited non-sensitive operational metadata is used; never send card information, credentials, customer email, Firebase UID, or project description.

## Required Resend configuration

Create a free Resend account and verify a domain or subdomain for sending. In Vercel → Project → Settings → Environment Variables, configure for Production:
- RESEND_API_KEY: Resend sending API key. Store as sensitive.
- RESEND_FROM_EMAIL: plain verified sender address, e.g. alerts@yourdomain.example (no display-name prefix).
- ADMIN_ALERT_EMAIL: recipient inbox; if absent the existing WEBSITE_ADMIN_EMAIL is used.
- Existing CRON_SECRET protects the existing daily billing Cron; no additional cron route or function is introduced.

Preview needs its own scoped sender/recipient/key if you want TEST alerts. Without those values the code records pending alerts but sends no mail. Redeploy after adding environment variables. Do not commit keys.

## Delivery behavior

- Live events attempt immediate send after the business transaction commits. Alert failures do not cancel a successful payment or Credits grant.
- The Firestore outbox is namespaced: billing_live_adminEmailAlerts or billing_test_adminEmailAlerts. A unique SHA-256 key, transaction lease and provider Idempotency-Key prevent routine duplicate notifications.
- Unsent alerts remain pending; the existing CRON_SECRET-gated annual Credits Cron additionally retries pending alerts daily at 03:00 UTC, up to eight items per run. Immediate retries are not guaranteed after outages, especially on Hobby.
- Sender configuration and domain verification must be completed before mail actually flows.
- API acceptance is not proof of inbox delivery; check Resend delivery logs and your inbox/spam folder.
- Existing historical orders are not backfilled. No new real payment is needed just to test the feature.
- Database-wide outages cannot be reliably emailed through a queue stored in that same database; configure a separate Vercel infrastructure alert for that case.

## Verify without payment

Once configured, verify the new production deployment is READY, the environment settings are scoped to Production, and future legitimate business events create documents in billing_live_adminEmailAlerts with status sent and a messageId. Inspect inbox and provider logs. No personal or secret fields are included.
