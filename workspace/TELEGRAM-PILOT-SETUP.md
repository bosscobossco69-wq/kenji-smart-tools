# Telegram Bot Pilot — gated integration (not yet live)

## What was implemented
- Reuses **POST /api/generate-reply?channel=telegram**; no new Vercel Serverless Function (Hobby quota).
- Requires Telegram's `X-Telegram-Bot-Api-Secret-Token` with constant-time comparison.
- Disabled (404) unless all four mandatory server-side settings are present and valid.
- Restricts responses to one explicitly allowed **private Telegram chat** for pilot testing.
- Requires the designated owner to be a verified Firebase user and to have passed legacy billing review.
- Uses the existing atomic Credits reservation / ledger, exactly one credit per successful reply by default.
- Replayed update IDs cannot create duplicate charges; error paths request safe refunds where possible.
- Inbound user messages never go into environment variables or logs by design.
- Refuses to generate when no GROQ_API_KEY is configured.

## Mandatory server-side environment variables (DO NOT paste values into chats or GitHub)
- TELEGRAM_BOT_TOKEN — Telegram BotFather token.
- TELEGRAM_WEBHOOK_SECRET — 32–256 characters from [A-Za-z0-9_-]; generate securely.
- TELEGRAM_OWNER_UID — Firebase UID for the one pilot owner.
- TELEGRAM_ALLOWED_CHAT_ID — numeric ID of the **pilot-only** Telegram private chat.
- Existing: GROQ_API_KEY, FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON.

## After a safe test deployment
1. Create a new bot using Telegram @BotFather. Store its token only in Vercel Production (or a protected preview).
2. Identify your private Telegram chat ID using Telegram's documented update API in a trusted environment; never post the token publicly.
3. Configure the four gated variables on the Vercel project and redeploy.
4. Set the bot webhook through official Telegram setWebhook with URL:
   https://kenjismarttools.com/api/generate-reply?channel=telegram
   Include secret_token equal to TELEGRAM_WEBHOOK_SECRET, and allowed_updates=["message"].
5. From the allowlisted private chat, send a plain-text message. Verify reply delivery, exactly one credit debit, and no duplicate charge on replay.
6. Test malformed/wrong secret, other chat ID, bot messages, /start, insufficient balance and Telegram or Groq failure.
7. Disable the integration immediately by removing one of the environment variables and redeploying if anything fails.

## Current non-goals / limits
- This is **not** multi-customer Telegram onboarding. Other chat IDs are ignored.
- Customer bot ownership, encrypted per-tenant credential vault, opt-in, knowledge bases, handoff and workspace controls are not implemented.
- This pilot does **not** use WhatsApp Cloud API; WhatsApp is a separate integration.
- Production credentials were NOT configured during this PR. The pilot is not live by default.
- Inspect send/ledger failure edge cases before broadening from a private pilot to customers.
