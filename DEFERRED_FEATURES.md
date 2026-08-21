# Deferred features

Ideas from the roadmap that are intentionally on hold — either because they
need a design decision we haven't made, or because they need real
infrastructure (not just a new card) to do properly. Kept here instead of
just in chat history so the reasoning survives.

## Rescheduled-task tracking

"How many times was this task rescheduled" (its `scheduled`/`due` date
changed). Unlike everything else on the roadmap, this needs to know about a
*change over time* — nothing in the vault or in TaskNotes' data currently
records that, so it can't be answered from the vault's current state the way
a stat/heatmap/list card normally would.

Three ways to build it, none started:

1. **Forward-only tracking.** Hearth watches for a task's scheduled/due value
   changing between two observations it makes itself, and increments a
   counter (Hearth's own plugin data, or written onto the task's frontmatter,
   e.g. `reschedule-count`). Cheapest to build. Only counts from whenever it
   ships onward, and can miss a change made while Obsidian is closed unless
   it diffs against a last-seen snapshot on load.
2. **Git-history mining.** Since the vault is a git repo, walk the commit log
   per task file and diff the `scheduled:`/`due:` line between consecutive
   commits. Retroactive — answers "how many times, ever" — but heavier
   (not something to compute on every render; more of a periodic/on-demand
   pass), and undercounts if multiple reschedules happened between two
   commits.
3. **Cheap proxy.** Just flag tasks whose current scheduled date is later
   than when they were first scheduled/created. Not a true count, but needs
   no new tracking machinery.

Display is a separate question once a mechanism is picked: a stat tile, a
heatmap of *when* reschedules happened, or a "most-rescheduled tasks" list.

## Map ("unlocking the map" — places visited)

A literal map showing where you've been, built from coordinates already on
Memory/Company/Organization/School notes: `coordinates` frontmatter as a
`"lat,lon"` string, populated via the shared `Templates/Scripts/location.js`
Templater helper (Nominatim geocoding). The convention already exists in the
vault; the card itself doesn't.

Two implementation paths:

- **Offline SVG world outline** with a lat/long → x/y projection, plotting a
  marker per unique location. Lighter, no network dependency, no tile-server
  rate limits — but looks like an outline map, not a real one.
- **Real slippy-map tiles** (e.g. bundled Leaflet). Pans/zooms like an actual
  map, but needs a bundled mapping library and live network access to a tile
  server.

A heatmap-density layer on top (more visits = more intense) is explicitly a
later step once the base map exists, per the original discussion.

## Hide the search-bar filter-row icons

The auto-detected file-type filter row under the search bar (header and the
search-bar card) is icon-only today — each chip has no visible text, only a
screen-reader label. "Remove the icons" therefore needs a decision about what
(if anything) replaces them:

- **Hide the whole row.** Simplest, and genuinely new as a *header* setting
  (the separate search-bar card already has its own `filters` toggle; the
  header currently always shows the row with no way to turn it off).
- **Swap icons for text-label pills** ("Notes", "Images", …). Keeps the
  filters usable without icons, but needs layout work — the chip row's
  spacing (`--n` column-gap trick in search.ts/styles.css) is currently sized
  around icon-only chips, not text.

## Related accuracy note (not deferred, just flagged)

The new "tasks completed" heatmap metric hits a smaller version of the same
problem as reschedule-tracking: TaskNotes' recurring tasks record a real
per-day completion date (`complete_instances`), but a plain one-off completed
task has no stored "completed on" date in this vault's data — only a
`status: done`. The heatmap falls back to the note's file-modified day for
those, which is a reasonable proxy (you usually save right after checking
something off) but not exact — an edit made well after completion would
misattribute the day. A fully accurate version would need the same kind of
forward-tracking or git-mining as reschedule-tracking above.
