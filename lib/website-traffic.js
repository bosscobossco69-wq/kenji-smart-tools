// Server-only optional Vercel Analytics reader. The access token must never reach the browser.
// No tracking cookies, customer emails, or Stripe data are sent to Vercel from this route.
const PROJECT = "prj_KGkAgaFGEuexVvFScXDDFR7fh29D";
const TEAM = "team_DgpB8hYbb8e7KR2Y4hKy5Dc2";
const API = "https://api.vercel.com/v1/query/web-analytics/visits/count";
let cached = null;
let expiresAt = 0;

export async function readCustomerTraffic7d() {
  const token = process.env.VERCEL_ANALYTICS_READ_TOKEN;
  if (!token) return { status: "not_configured", visitors: null, pageviews: null, note: "Server-side Vercel Analytics access token is not configured." };
  const now = Date.now();
  if (cached && now < expiresAt) return cached;
  const until = new Date(now);
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const url = new URL(API);
  url.searchParams.set("projectId", PROJECT);
  url.searchParams.set("teamId", TEAM);
  url.searchParams.set("since", since.toISOString());
  url.searchParams.set("until", until.toISOString());
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? "authorization_required" :
        response.status === 402 ? "plan_restricted" : "unavailable";
      return { status, visitors: null, pageviews: null, note: "Vercel Analytics access unavailable (" + response.status + ")." };
    }
    const payload = await response.json();
    const visitors = payload?.data?.visitors, pageviews = payload?.data?.pageviews;
    if (!Number.isSafeInteger(visitors) || visitors < 0 || !Number.isSafeInteger(pageviews) || pageviews < 0) {
      return { status: "unavailable", visitors: null, pageviews: null, note: "Vercel returned an unexpected response." };
    }
    cached = {
      status: "ready", visitors, pageviews,
      since: payload?.query?.since || since.toISOString(),
      until: payload?.query?.until || until.toISOString(),
      note: "Vercel Web Analytics production traffic; includes administrator browsing and may omit untracked visitors."
    };
    expiresAt = Date.now() + 5 * 60 * 1000;
    return cached;
  } catch {
    return { status: "unavailable", visitors: null, pageviews: null, note: "Vercel Analytics could not be reached." };
  }
}
