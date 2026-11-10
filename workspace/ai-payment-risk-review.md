# KENJI AI Workspace — payment risk review contract

## Status

**Design only; no AI provider is connected and no payment-risk decision is automated.**

This document defines a future advisory review layer for payment and account-abuse signals. It does not enable Checkout, webhook processing, Credit grants, refunds, disputes, account holds, or account bans.

The payment authority remains deterministic server-side verification plus an atomic database transaction. An AI risk result is never proof of payment and must never override a failed payment verification.

## Responsibilities and authority

### Deterministic payment controls (authoritative)

The backend must independently verify all of the following before changing payment, Credit, or entitlement state:

- Stripe webhook signature using the endpoint-specific secret and exact raw request body.
- Canonical Stripe Checkout Session / PaymentIntent retrieved server-to-server.
- Correct Stripe account and test/live mode.
- Exact internal order, authenticated user, expected amount in integer minor units, and currency.
- Canonical paid/captured status and consistency of customer and metadata identifiers.
- Idempotency, unique event identity, and atomic ledger/entitlement transaction.

If any required check fails or is unavailable, do not grant Credits or entitlements. Queue a technical retry or manual investigation as appropriate.

### AI risk assistance (advisory only)

A future model may summarize minimized transaction signals and return:

- risk_level: low, medium, high, or unknown
- risk_score: integer 0–100, or null when insufficient evidence exists
- reason_codes: a bounded list of approved machine-readable codes
- needs_human_review: boolean
- evidence_summary: short factual explanation referencing supplied signal IDs only
- model_version and policy_version

The model must not return or control payment status, refund approval, Credit amount, entitlement status, account suspension, or permanent-ban decisions. Treat model output as untrusted input: validate its schema, bounds, allowed reason codes, and response size.

## Suggested review signals

Use only signals that are lawfully collected, necessary for fraud prevention, disclosed where required, and covered by the project's privacy and retention policy.

Potential signals include:

- Repeated checkout creation or payment attempts within a short, policy-defined window.
- Repeated provider declines or mismatches between an internal order and canonical provider object.
- Duplicate or conflicting provider event identifiers.
- Unusual velocity across orders for the same pseudonymous account identifier.
- Repeated refund/dispute patterns supported by verified provider records.
- Account age or recent account changes, only where relevant and proportionate.
- Reuse of a pseudonymous device/network risk token, only if collection and use are lawful and disclosed.

Do not infer fraud from nationality, ethnicity, religion, gender, disability, health, or other sensitive/protected traits. Do not use raw card data, CVC, passwords, authentication tokens, government identifiers, full addresses, or unnecessary message contents as model input.

## Initial policy bands (provisional; require validation)

These bands are review-routing suggestions, not a production fraud model:

- **Low (0–29):** no additional AI-driven review. Normal deterministic payment verification still applies.
- **Medium (30–69):** create a review record and request human review when the payment or account action is material.
- **High (70–100):** prioritize human review and apply only a pre-approved temporary operational hold if the product policy and law permit it. Do not automatically refund, permanently suspend, or deny a verified payment solely because of the score.
- **Unknown:** insufficient, unavailable, or invalid model output. Follow deterministic controls and route to manual review only when a separate deterministic rule requires it.

Do not deploy these numeric thresholds until tested against representative, lawfully obtained data, calibrated for false positives/negatives, and approved by an accountable operator. A score must not be presented as a probability unless it has been calibrated as one.

## Human review and audit trail

For each review, store only the minimum necessary:

- Internal review ID, order ID, pseudonymous user reference, and related provider event IDs.
- Deterministic rule codes and references to verified evidence.
- Risk level/score, reason codes, model and policy versions, and timestamp.
- Reviewer decision (approve, hold, release, reject, or escalate) with a required reason.
- Previous and new operational state, actor type, and immutable audit timestamp.

Human reviewers must see the underlying verified evidence and the model's limitations. Provide a way to correct inaccurate signals and appeal consequential account restrictions. Record overrides; do not silently rewrite prior review history.

## Privacy, security, and reliability

- Send no secrets, cardholder data, raw payment credentials, or direct personal identifiers to an AI service.
- Prefer pseudonymous IDs, coarse time windows, bounded counters, and explicit signal codes.
- Document the AI provider, region, retention/training settings, subprocessors, cost limits, and incident process before integration.
- Apply access controls, encryption, retention limits, deletion workflows, and audit logging to review records.
- Set strict request timeouts, token/size limits, rate limits, and budget caps.
- If the AI service is unavailable, slow, or returns invalid output, fail safely: payment verification continues independently; no model output can grant payment or entitlement.
- Do not make external model calls from webhook request handling if that could delay or block provider acknowledgement. Use an asynchronous review queue after durable event recording.
- Avoid duplicate model charges by making review jobs idempotent and recording the model/policy version.

## Rollout gates

1. Approve privacy, legal basis, retention, and vendor settings.
2. Define deterministic rules and a labeled evaluation dataset with appropriate safeguards.
3. Run in shadow mode: record advisory scores without changing customer outcomes.
4. Measure false-positive/false-negative rates, calibration, subgroup impact where lawful, latency, and cost.
5. Obtain human approval for thresholds and escalation policy.
6. Enable limited human-review routing behind a feature flag.
7. Reassess regularly and retain a kill switch.

No automated adverse action should be enabled by this design alone.

## Explicit non-goals

This document does not implement an AI model, provider SDK, risk API, queue, dashboard, customer scoring, identity profiling, automatic decline, automatic refund, permanent ban, payment hold, or production payment activation.
