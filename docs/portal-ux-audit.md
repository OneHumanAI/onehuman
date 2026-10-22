# Portal UX audit (/portal)

Scope: `web/portal.html`, `web/portal.css`, `web/portal.js`, `web/portal-auth.js` (sign-in logic only, no UI).
Method: local server (`npm run dev` on a throwaway SQLite file), two test accounts created through the portal's own
sign-up API (one empty, one with 780 decisions over 30 days, three keys, a saved rule set and a management key).
Every screen was captured at 1440 px and 375 px, signed out, empty and with data, plus the dialogs and menus.
No real credentials were used.

Severity: **P1** breaks or blocks something, **P2** confuses or looks inconsistent, **P3** polish.

## The short version

The portal looks like a different product from onehuman.ai. It runs its own design system (shadcn "slate" blues,
Geist, its own buttons, a light/dark/system switch) while every public page runs the dark `.home` system from
`landing.css` + `site.css`. On top of that, most screens show the same numbers two or three times, give every
block the same weight, and offer several equal buttons with no clear first step. `portal.css` grew by layering
"overrides above" sections, so the same selector is often defined two or three times.

## Across every screen

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | **Different design system from the site.** Blue-black `#020817` background, slate greys, Geist font, white 6 px buttons, its own `.btn`. The site is `#0a0a0b`, Inter + Geist Mono, mint accent, 5 px buttons from `site.css`. | Load `site.css`, take colours, fonts and `.btn` from it. Delete the portal's own palette and button styles. |
| P2 | **Light/dark/system switch** in the user menu, plus `theme-boot.js`. The owner decided dark only. | Remove the switch, the boot script and the theme code. |
| P2 | **Three layers of chrome**: a sidebar, an inset rounded panel, and an 80 px top bar that repeats the page title, a search box and an "Agent protection · Live" pill on every screen. | One sidebar and the page. The page title sits on the page with its one-line description and its actions. Live status moves to the sidebar, once. A slim bar with the menu button only on phones. |
| P2 | **No single primary action.** White "primary" buttons appear two or three times per screen (Overview, Plan, Weekly). | One primary button per screen, the next step. Everything else is a secondary or ghost button. |
| P2 | **Cards inside cards.** Grey `bg3` boxes inside bordered cards (integration checks, news, policy items, code blocks) and bordered boxes inside bordered strips (activity stats). | One level of card. Rows inside a card are separated by a hairline. |
| P2 | **Duplicate CSS.** `.btn`, `.card`, `.ucard`, `.range`, `.chip`, `.mode`, `.pol-row`, `.pol-status`, `.pol-un`, `.pol-item`, `.menu`, `.modal`, `select` are each defined two or three times, the later ones overriding the first ("NanoTarget look … overrides above"). `.uhead/.ubars/.ulegend`, `.legend/.l-*`, `#chart`, `.assist-*`, `#as-out`, `.chip-btn`, `.res`, `.bar` are dead. | Rewrite `portal.css` once, on the site's tokens: 74 KB to about 52 KB. |
| P2 | **Destructive confirms look harmless.** `ask({ danger: true })` toggles `.btn.danger`, but no style exists, so "Revoke", "Rotate", "Delete" are plain white buttons. | Add `.btn.danger` to the shared buttons in `site.css`. |
| P3 | Section labels mix "Monitoring/Protection", sentence case and Title Case ("API Keys", "+ New Key", "View Activity ›"). | Sentence case everywhere: "API keys", "New key". Group labels "Monitor", "Protect", "Account". |
| P3 | Copy is long. Page descriptions run to two lines and repeat the page title; empty states explain twice. | Cut to one short line. |

## Sign-in and sign-up (signed out)

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Header is a plain line with "← onehuman.ai", not the site's top bar. No footer. Feels like a third-party page. | The site's `.nav` bar (logo, "Back to site") and the site's footer, from `site.css`. |
| P2 | Two columns of equal weight: the form, and three bordered step tiles plus a paragraph. The eye goes to the tiles. | Form card first and alone. The three steps become a plain numbered list under it, no boxes. |
| P3 | "Book 15 minutes" is styled like body text, so it is not visibly a link. | Underlined link style from the site. |
| P3 | The error sits between the button and the switch link and pushes the layout; the "Forgot your password?" row is right-aligned on its own line. | Error directly under the fields; forgot link next to the password label. |

## Overview

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Five blocks before any number: the trial card, the alerts card, a "Start by just watching" banner that repeats the trial card, a section title, and four stat cards. | Trial card, then the numbers. Remove the banner (the trial card already says "Nothing is blocked"). |
| P2 | Four "quick link" cards at the bottom repeat the sidebar. | Remove them. |
| P2 | The sidebar shows "Sessions with an AI agent 27%" a second time, under the same number on the page. | Remove the sidebar card. |
| P3 | Four separate stat cards with 28 px light numbers. | One stat strip: four cells in one card, divided by hairlines. |
| P3 | The empty account shows a flat zero chart and four zeros with no hint. | The trial card ("Create an API key") is the one action; keep the zeros quiet. |

## AI agents

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Per agent, the count column floats: its position depends on how wide the chips are, so it jumps between cards. | Fixed column widths (part of the app, count, outcomes). |
| P3 | Resource names in grey code boxes inside the table add a third background. | Plain mono text. |
| P3 | Outcome colours differ from the Rules screen (two blues, a pink). | One outcome palette everywhere: open = mint, hidden = blue, passkey = amber, refused = red. |

## Activity

| Sev | Problem | Fix |
| --- | --- | --- |
| P1 | Log times show only `HH:MM:SS` in the 7 and 30 day ranges, so rows from different days read as one day. | Show the date with the time outside the 24 h range. |
| P1 | Phone: the log filter lives in the top bar, which phones hide, so the log cannot be filtered on a phone at all. | The filter moves into the log's own header. |
| P2 | Eleven numbers in two strips and five boxes, with "sessions with an agent" and "limited or stopped" shown twice; the fifth box ("stopped by mistake") sits alone on a third row. | One summary card: four headline numbers (share of sessions with an agent, people blocked, limited or stopped, stopped by mistake) and one line of supporting counts. |
| P2 | The decision log has no column headers, and rows change height when the "who" chips wrap. | A header row; chips stay on one line. |
| P2 | The search box for the log lives in the top bar, far from the log. | A filter field in the log's header. |
| P3 | "live · export CSV · export proofs · auditor report (PDF)" are tiny underlined lowercase links. | Small buttons in the log's header. |
| P2 | Phone: the "waiting for your app" code sample is wider than the card and is cut off. | Code blocks scroll inside themselves. |

## Weekly report

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Six KPI boxes, a summary card and four nested grey news boxes. | KPIs as one strip; news as rows in one card. |
| P2 | No primary action, though the page exists to be forwarded. | "Save as PDF" is the primary; "30-day report" secondary. |
| P3 | Empty state is one grey sentence with no way forward, under three report buttons that do nothing yet. | Empty state with "Create an API key"; the report buttons hide until there is a report. |

## Rules

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | The agent panel is the loudest thing on the page: animated aurora, glowing gradient border, spinning orb, gradient send button. | A plain card in the site's style; the orb stays small and still. |
| P2 | Outcome colours (`--o-*`) are a separate palette from the rest of the portal and the site. | The shared outcome palette. |
| P2 | Phone: the "Ask the agent" button floats over the rules. | Room at the bottom of the page for it. |
| P3 | The key picker shows a truncated "name · name · prefix" that runs into its arrow. | Wider picker, text ellipsis before the arrow. |

## API keys

| Sev | Problem | Fix |
| --- | --- | --- |
| P1 | Phone: the table is 720 px wide inside a 343 px card; Status and everything after it are off screen. | Phone hides the secondary columns (environment, expiry, last used, checks); the row keeps name, status, share and the menu. |
| P2 | Two search boxes on the page (top bar and table). | One, in the table. |
| P3 | Empty account: a table header over "No keys yet". | No header when empty; "New key" is the page's primary. |

## Set up

| Sev | Problem | Fix |
| --- | --- | --- |
| P1 | Phone: the page scrolls sideways by 169 px (the two-column "Test it yourself" fields and the code blocks). | Fields stack on phones; code blocks scroll inside themselves. |
| P1 | Desktop: the coding-agent prompt is cut off on the right (no wrapping, no scroll). | The prompt wraps. |
| P2 | The order puts the integration check (four grey "waiting" boxes) above the install steps, so a new user starts with four empty lights. | Steps first, then "let your coding agent do it", then the check. |
| P3 | Copy buttons sit on top of the code text on phones. | Copy button above the code on phones; code padded so it never sits under the button. |

## Plan and usage

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Two primary buttons ("Choose Pay as you go", "Choose Growth"), and the current plan's disabled button looks broken. | One primary (the next plan up); the current plan says "Your plan" quietly. |

## Settings

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | The page opens on management keys and a ten-line API reference, the least used part. The description mentions "appearance", which is not on the page. | Account, e-mails and password first; management keys after; the endpoint list folds away. |
| P3 | "Change password" is a white primary button inside one card of five. | Secondary button. |

## Dialogs, menus, states

| Sev | Problem | Fix |
| --- | --- | --- |
| P2 | Dialog styles are defined twice and patched with `!important`. | One dialog style on the site tokens. |
| P3 | The loading screen (signed-in visitor) draws a blurred fake dashboard in slate blues. | Just the mark and a ring, in the site's colours. |
| P3 | The "AI agent in this tab" bar uses a hard-coded pink. | The site's danger colour. |

## How the portal differs from the public design system

| | Public site (`landing.css`, `docs.css`, `site.css`) | Portal before |
| --- | --- | --- |
| Background | `#0a0a0b`, cards `#101013` | `#020817` / `#050c1d` (slate blue) |
| Lines | `rgba(255,255,255,.08 / .14)` | `#1e293b` / `#334155` |
| Text | `#f2f2f3`, `#a1a1aa`, `#6b6b74` | `#f8fafc`, `#94a3b8`, `#64748b` |
| Accent | mint `#7df0c0`, blue `#8ab4ff`, red `#ff7b7b` | teal `#5fb3a8`, violet `#8b8df0`, red `#f87171`, plus `--mint`, `--khaki`, `--bluelight`… |
| Type | Inter, Geist Mono | Geist, Geist Mono |
| Buttons | `site.css` `.btn` (5 px radius, outline; primary white) | its own `.btn` (6 px, different hover, no danger) |
| Theme | dark only | light, dark, system |
| Header/footer | `.nav` + `.foot` from `site.css` | its own top line, no footer |

Fixed by making `site.css` the source of the shared tokens (`:where(:root)`, so each public page's own values still
win and nothing on those pages changes) and building the portal on them.

## Not fixed here (follow-ups)

- **Three words for the same outcome.** Rules say Open / Hidden / Passkey / Refused, the Activity bars say let through /
  details hidden / asked for a passkey / turned away, the AI agents page says Allowed / Hidden / Waiting for approval /
  Never shared, and the log shows the raw codes (`allow`, `step_up`). One set of words would help; it is a copy
  decision for the owner, so this change only unifies the colours.
- **Tokens still live in each public page's stylesheet** (`landing.css`, `docs.css`). `site.css` now carries the same
  values as defaults; the page copies can be deleted page by page later.

## Before and after

What changed, in one line each:

- One sidebar (Monitor, Protect, Account) and the page. The top bar, the inset panel, the search box in the bar, the
  sidebar stat card and the theme switch are gone. Phones get a slim bar with the menu button and the page name.
- Colours, type and buttons come from `site.css`. New shared pieces there: the token defaults (`:where(:root)`), and
  `.btn.sm`, `.btn.danger`, `.btn:disabled`, centred button labels.
- One primary button per screen; destructive confirms are red.
- Stat strips instead of rows of boxes; one level of card; hairlines between rows.
- Activity: four headline numbers and one line of counts; a header row for the log; dates in the log; the filter and the
  exports in the log's header.
- Set up: steps first, the coding-agent prompt second, the check third; nothing scrolls sideways.
- Copy cut on every page description, the sign-in screen, empty states and dialogs.
- `portal.css` rewritten once: 74 KB of layered overrides to one pass of about 52 KB, no unused classes.
- `portal.js`: presentation and copy only. The theme code, the banner and the sidebar card writes are removed with their
  elements; the log time carries a date outside 24 h; labels are sentence case; empty states and the plan grid use the
  new button classes. No API call, payload or flow changed.
- `web/theme-boot.js` is deleted: only the portal loaded it.

| Screen | Before | After |
| --- | --- | --- |
| Sign up | ![](media/portal-ux/desktop-auth-signup-before.jpg) | ![](media/portal-ux/desktop-auth-signup-after.jpg) |
| Overview | ![](media/portal-ux/desktop-overview-before.jpg) | ![](media/portal-ux/desktop-overview-after.jpg) |
| Activity | ![](media/portal-ux/desktop-activity-before.jpg) | ![](media/portal-ux/desktop-activity-after.jpg) |
| API keys | ![](media/portal-ux/desktop-keys-before.jpg) | ![](media/portal-ux/desktop-keys-after.jpg) |
| Rules | ![](media/portal-ux/desktop-policy-before.jpg) | ![](media/portal-ux/desktop-policy-after.jpg) |
| Set up | ![](media/portal-ux/desktop-integrate-before.jpg) | ![](media/portal-ux/desktop-integrate-after.jpg) |
| Weekly report | ![](media/portal-ux/desktop-weekly-before.jpg) | ![](media/portal-ux/desktop-weekly-after.jpg) |
| Revoke a key | ![](media/portal-ux/desktop-modal-confirm-before.jpg) | ![](media/portal-ux/desktop-modal-confirm-after.jpg) |
| Phone: overview | ![](media/portal-ux/phone-overview-before.jpg) | ![](media/portal-ux/phone-overview-after.jpg) |
| Phone: API keys | ![](media/portal-ux/phone-keys-before.jpg) | ![](media/portal-ux/phone-keys-after.jpg) |
| Phone: set up | ![](media/portal-ux/phone-integrate-before.jpg) | ![](media/portal-ux/phone-integrate-after.jpg) |
| Phone: rules | ![](media/portal-ux/phone-policy-before.jpg) | ![](media/portal-ux/phone-policy-after.jpg) |

The "before" phone set-up shot is wider than 375 px because the page itself scrolled sideways.

Every screen was captured both times (58 shots each pass): signed out (sign up, sign in, wrong password, connect code),
the empty account and the account with data on all nine views, the new-key, share and revoke dialogs, the key and user
menus, the phone menu, the loading screen and the "AI agent in this tab" state, at 1440 and 375 px.

## How it was checked

- **Horizontal scroll**, measured on every view at both widths: before, Set up scrolled 169 px sideways on phones and the
  keys table hid five of eight columns off screen; after, 0 everywhere.
- **Console**: no errors or warnings on any screen load or view change. During the click-through the only failed
  requests are the same as on `main`: polling calls that answer 401 in the moment after sign-out, and the 403 that asks
  for the password before a weakening rule change.
- **Click-through on both widths**: sign up through the form, switch to sign in, create a key, rename it, open revoke
  and cancel, filter the log, pause and resume live, change and save a rule, switch set-up tabs, toggle e-mails, sign
  out from the user menu.
- **Public pages unchanged**: all twelve pages that load `site.css` were rendered from `main` and from this branch at both
  widths and compared pixel by pixel. All identical, except the full-width "Scan" button on `/scan` at phone width, whose
  label is now centred by the shared button rule.
- `npm test`: 284 of 284 pass.
- The portal guards itself with OneHuman, so headless Chromium reads as an AI agent: it seals the page, masks secrets
  and blocks sign-in. The screenshots and the click-through ran with `navigator.webdriver` off and typed like a person;
  the "agent in this tab" shots ran with it on.
