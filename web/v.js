// SPDX-License-Identifier: BUSL-1.1
// Counts one page view for the operators' view. The page itself comes from the CDN cache, so the server does not see it.
try {
  const r = document.referrer ? new URL(document.referrer).host : '';
  navigator.sendBeacon('/api/v1/visit', JSON.stringify({ p: location.pathname, r: r === location.host ? '' : r }));
} catch { /* counting must never break the page */ }
