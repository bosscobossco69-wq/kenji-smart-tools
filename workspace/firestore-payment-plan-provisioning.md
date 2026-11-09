# Firestore payment plan provisioning contract

## Purpose

The Stripe server-side plan loader reads `plans/{planId}` from the dedicated KENJI AI Workspace Firestore database. The browser must never supply an amount, currency, Credits grant, or billing interval.

This document defines the required record shape. It does **not** provision Firestore, create plan records, or enable checkout.

## Required document shape

Each document in `plans` must contain:

| Field | Type | Rule |
|---|---|---|
| `active` | boolean | Must be exactly `true` to be purchasable |
| `name` | string | Display label; never used as a price source |
| `unitAmountMinor` | integer | Positive safe integer in MYR sen |
| `currency` | string | Must be `myr` |
| `creditsGrant` | integer | Non-negative safe integer |
| `billingInterval` | string | `one_time`, `month`, or `year` |

Do not create production prices or set `active: true` until the owner approves the exact MYR price, Credits quantity, and product terms.

## Initial Sandbox scope

The first checkout implementation should accept only a one-time Credits product. Monthly and yearly intervals remain blocked until subscription lifecycle, renewal, cancellation, past-due handling, refunds, and entitlement expiry are implemented and tested.

A plan with `billingInterval: "month"` or `"year"` must not be silently converted to a one-time payment.

## Environment and database boundary

- Use a dedicated Firebase project for KENJI AI Workspace.
- Configure the project ID and service-account JSON only in the private server-side Vercel environment.
- Never reuse Cardora / Pokémon Treasure database credentials or collections.
- Firestore client rules remain deny-by-default; all plan writes are administrative/server-side only.
- The current repository's Firebase Admin code can connect to Firestore, but repository code does not prove that a remote Firestore database has been provisioned or configured.

## Safe provisioning checklist

1. Confirm the dedicated Firebase project ID in Firebase Console.
2. Confirm Firestore database exists in that project and is in the intended region.
3. Confirm the Vercel Preview environment has the matching `FIREBASE_PROJECT_ID` and private `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Create plan records only after the owner confirms exact commercial values.
5. Read each plan through the server-side `getActivePaymentPlan` function in a controlled test.
6. Keep `STRIPE_CHECKOUT_ENABLED` unset/false until Checkout, webhook reconciliation, and emulator tests are complete.
7. Do not enable Live keys or real payments as part of Sandbox validation.

## Current status

- Plan reader: implemented in `api/_lib/payment-plans.js`.
- Pending order service: implemented in `api/_lib/payment-order-service.js`.
- Plan documents in the remote Firestore project: **not verified**.
- Dedicated Firestore provisioning and Preview credentials: **not verified**.
- Stripe SDK and Checkout / webhook integration: **not implemented**.
- Real payments: **disabled**.
