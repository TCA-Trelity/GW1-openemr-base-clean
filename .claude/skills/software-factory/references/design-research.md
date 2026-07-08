# Design Research — UI Baseline

Every deliverable ships a visual UI surface — even inherently headless builds (pipeline, scraper, API) get a minimal dashboard or report view as the consumption layer. No deliverable is terminal-only. The reason: the user judges the build through what they can see and click; an excellent engine behind a shabby surface reads as a shabby build.

## Step 1: Anchor on an exemplar

Before writing any UI code, identify 1-2 best-in-class products in the same domain and anchor the design on them. Being anchored on an excellent reference beats designing from scratch — taste is easier to borrow than invent.

Seed map (starting points, not limits):

| Domain | Exemplars |
|--------|-----------|
| Education / tutoring | Brilliant, Khan Academy |
| Finance / investing | Wealthfront, Copilot Money |
| Real estate / property mgmt | Airbnb, Zillow |
| Analytics / dashboards | Linear, Stripe Dashboard |
| Productivity / tools | Notion, Things |
| Dev tools | Vercel, Linear |
| Health / wellness | Whoop, Headspace |
| E-commerce | Shopify storefronts, Apple Store |
| Content / reading | Medium, Substack |

If the domain isn't on the map, **research it**: web-search "best designed [domain] app", award lists (Apple Design Awards, Awwwards, Godly), and "[domain] UI inspiration". Pick the exemplar whose *use context* matches (dense pro tool vs consumer-friendly), not just the prettiest.

## Step 2: Extract a design direction

From the exemplar, write a 4-6 line design direction — this goes into GATE 1 for approval:

```
Design reference: Wealthfront
- Layout: card-based, single column, generous whitespace
- Palette: near-white ground, one muted accent (deep teal), semantic green/red only for money
- Type: one sans family, large numerals for key figures, quiet labels
- Density: low — few numbers per screen, each earning its place
- Signature move: hero number + sparkline at top of every view
Maps to our screens: [one line per screen]
```

Borrow the direction, not the assets: no logos, no copied artwork, no trade dress cloning. The exemplar sets the bar for spacing, hierarchy, and restraint.

## Step 3: Build to the quality bar

Baseline for every UI, every tier (MVP included — simple scope, not sloppy execution):

- **Hierarchy**: one obvious primary action per screen; size/weight/color signal importance
- **Spacing**: consistent scale (4/8px grid); whitespace is a feature, cramped is a bug
- **Typography**: max 2 families; consistent sizes; real hierarchy between headings, body, labels
- **Color**: restrained palette — ground + one accent + semantic colors; no rainbow dashboards
- **States**: empty state (designed, not blank), loading, error, and success are all real states
- **Interactions**: hover/focus feedback on everything clickable; nothing clickable that looks inert, nothing inert that looks clickable
- **Data formatting**: dates, currency, and numbers formatted for humans ($1,516,350 not 1516350)
- **Responsiveness**: at minimum, doesn't break at common widths (unless PRD says fixed-context demo)

Demo tier raises the bar further: the client sees polish first and function second.

## Step 4: Verify the UI like a user

UI verification is part of Phase 3, not optional garnish. Exercise the surface, not just the logic:

- Click **every** link and button — each does something sensible or doesn't exist
- Walk each screen: check formatting, alignment, spacing, and text overflow with realistic data (long names, big numbers, empty lists)
- Trigger empty/error/loading states deliberately
- Screenshot (or describe screen-by-screen) what was checked; put UI findings in the verification block, including what wasn't visually verified

A build where the logic passes 26 assertions but a button dead-ends is a failed build.
