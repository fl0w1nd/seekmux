# Signal — the SeekMux design system

Signal is the interface system of the SeekMux console. It is built for one
job: operating a gateway. The screen shows machine facts (latencies, quotas,
routes, keys) and a small number of settings, so the system is dense and
quiet: white sheets on a light canvas, hairlines, weight instead of ornament,
and a single loud color reserved for what matters right now.

The living reference is the `/design` page of the console (`src/pages/Design.tsx`),
which renders every token and component. Tokens live in `src/styles/index.css`;
components in `src/ui/`.

## Principles

1. **One signal.** There is exactly one brand color, a lime. It marks the
   primary action on a screen and things that are live. It is never decoration.
2. **Quiet depth.** The canvas (`bg`) carries the navigation; content sits on
   white sheets (`surface`) that are lifted off it by a hairline and a faint
   two-layer shadow. Inside a sheet, depth is a fill; the only shadow there is
   the small one of a thumb.
3. **One closed border per thing.** A panel draws one box. What is inside it
   is divided by lines and fills: buttons, badges, segmented controls and
   selected rows are filled, not outlined, so a control never draws a second
   box inside the first. Fields are the exception, since a field must read as
   a place to type. A group of rows inside a panel (a `ChoiceList`, a list of
   rows) may take one `rounded-ctl` frame of `line`.
4. **Emphasis is weight, not ornament.** Titles are semibold, chosen things are
   a fill or a white thumb with `shadow-thumb`; not a colored bar, not a ring
   plus a bar. Numbers, prefixes and caps do not decorate titles.
5. **Machine text is mono.** Anything a machine produced or will consume —
   numbers, durations, IDs, URLs, keys, model names — is set in IBM Plex Mono
   with tabular figures (`num`). Everything a person reads is IBM Plex Sans.
6. **State is a dot plus a word.** Never color alone. A breathing dot means
   "happening at this moment" and nothing else.
7. **Settings are rows, data is tables.** A setting says what it is on the
   left and holds its control on the right.
8. **The interface shows; it does not explain.** A label, a value and a
   control carry the meaning. Text that explains is the exception (see
   Writing).
## Writing

- A label stands on its own. By default a setting has no hint, a panel no
  description and a page no description.
- Show the value instead of describing it: a field at 0 says what 0 means in
  place of its suffix (`不限`, `沿用模型`, `全局 24 步`), a field that inherits
  shows the inherited value as its placeholder, an example goes in the
  placeholder.
- A value from a fixed set (a country, a language, a model) is picked from a
  list that holds only what the provider takes, never typed. Free text shows
  a real example in its placeholder, and an invalid value says the rule
  (`1 – 100 的整数`), not only a red border.
- A setup that happens outside the console (installing an extension,
  running a worker) is a guide of numbered steps, each checked against what
  the gateway can see.
- An inline hint is for what the user would otherwise get wrong: a unit, a
  format, a consequence that cannot be undone. One short clause, no `；`.
- A mechanism that is worth knowing but not needed to set the value goes
  behind `Info` (the ⓘ next to a label). How the gateway works inside belongs
  in the README.
- Another page is a link or a button, never "前往「X」中设置".
- A control that cannot be used is disabled, with the reason on `Info` or a
  tooltip, instead of a warning below it.
- An empty state is a title, and an action button when there is something to
  do. It does not describe what will appear.
- A `Notice` is for something that is wrong now, and offers the fix. It is not
  for background.
- A confirmation says the consequence the user would not expect. Everything
  applies at once, so "立即生效" is never said.
- Each fact is said in one place.
- Console text is Chinese, terse and neutral. No chatty asides.

## Tokens

Colors are OKLCH custom properties on `:root`, with a dark set applied by
`prefers-color-scheme` or `data-theme`. Tailwind's default palette is switched
off (`--color-*: initial`), so only these names exist as utilities.

| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `bg` `surface` `sunken` `overlay` `thumb` | canvas and navigation; panels and fields; code and recessed areas; floating layers; the knob of a switch and the chosen option of a segmented control |
| Lines | `line` `line-strong` | separators and containers; fields |
| Fills | `fill` `fill-strong` | hover, secondary buttons, tracks and chosen rows; pressed, skeletons |
| Text | `ink` `ink-2` `ink-3` | primary, secondary, captions and placeholders (`ink-3` holds 4.5:1 on `surface`) |
| Brand | `signal` `signal-hover` `signal-ink` `signal-text` | fill, hover fill, text on the fill, brand-colored text on a surface |
| Status | `ok` `warn` `err` `info` | kept off the brand hue so success never reads as brand |
| Charts | `chart-1` … `chart-4` | the series of a chart in stacking order; failures stay `err` |

Neutrals are one near-neutral hue (106) at very low chroma, so they read as
gray next to the lime instead of drifting green. Lines and fills are ink at a
low alpha (10 % and 18 %, 4.5 % and 8.5 %), so one value reads the same on
`bg`, `surface` and `overlay`. `sunken` is for code and recessed areas only;
fields are `surface`.

**Type.** Seven sizes, each with a fixed line height: `2xs` 11, `xs` 12,
`sm` 13, `base` 14, `lg` 16, `xl` 20, `2xl` 28, plus `title` 22 for the page
title. Body is `base`; controls and tables are `sm`. Two display sizes, `3xl`
36 and `4xl` 52, are for the report page only. Use the roles rather than
picking sizes:

| Role | Utility | Use |
| --- | --- | --- |
| Page title | `t-title` (22, semibold) | `PageHeader`, the gate and authorize screens |
| Heading | `t-heading` (14, semibold) | the title of a panel, a drawer, a dialog |
| Label | `tag` (sans 12, medium, `ink-3`) | the caption over a group, a column, a figure, a lane |
| Latin caps | `caps` (mono 11, uppercase, tracked) | a machine label such as a method or a language tag; never Chinese |
| Machine text | `num` (mono, tabular) | numbers, IDs, URLs, keys, model names |

**Shape.** Four radii: `rounded-tag` (4px) for badges, keys and skeleton
lines; `rounded-thumb` (5px) for the option inside a control (a segmented
thumb, a list item); `rounded-ctl` (7px) for controls and groups of rows;
`rounded-panel` (12px) for panels and floating layers. Controls are 32px
tall, 28px in dense places.

**Elevation.** Four shadows, all faint: `shadow-panel` lifts a sheet off the
canvas, `shadow-raise` is a clickable card under the pointer (and the
playground composer), `shadow-thumb` is the white thumb of a switch or a
segmented control and the chosen item of the sidebar, `shadow-overlay` is a
dialog, a drawer, a popover, a toast. `shadow-ring` is the focus halo of a
field. No other shadows.

**Layout.** Navigation rails (the global sidebar and in-page master-detail
directories) sit on `bg` so that `surface` belongs only to active sheets and
panels; a master-detail view shares one `rounded-panel` frame split by a 1px
line rather than two separate cards of uneven height, and the frame is at
least as tall as the viewport allows, so the detail is never shorter than its
directory. Every monitoring and management page shares a single `68rem`
(`max-w-[68rem]`) outer frame so page headings and panel edges never jump when
moving down the sidebar; only workbenches and full-page call flow canvases
(`/play/*`, `/logs/:id`) expand to `96rem` (`max-w-[96rem]`). The playground
uses the same `PageHeader` as every other page.

Inside panels, settings rows (`Row`, `CardRow`) align on a fixed left label
column (`11rem` in full-width panels, `8.5rem` inside a split detail pane) with
controls placed immediately beside the label and short hints inline after the
control, never pushed to opposite ends of a wide card. Controls size to the
value they hold: numbers take `w-20`–`w-32`, short names and selects
`w-48`–`w-72`, URLs and secrets at most `max-w-md`. All panels, tables and lane
lists share `px-4` horizontal padding and `gap-3` between stacked panels;
panel headers are `min-h-12`, table headers `h-9` and table rows `h-11`. A
`Panel` groups a coherent domain of settings — do not wrap a single setting in
its own panel.

**Motion.** 140ms ease-out for entering layers, 200ms for the drawer. Every
button gives under the finger (`press`, scale 0.98). Folding regions
(`animate-fold-down` / `animate-fold-up`) and moving quantities (`useTween` in
`lib/motion.ts`) use `ease-settle`. New bars grow from their baseline
(`animate-grow-x` / `animate-grow-y`); a row arriving in a live list fades in
once (`animate-arrive`). Motion only shows a change of state; nothing loops
except the dot of something live and the sheen of a skeleton. All of it is off
under `prefers-reduced-motion`.

## Components

- `primitives.tsx`
  - Actions: `Button` (primary / secondary / ghost / danger; secondary and
    danger are filled, a disabled primary goes neutral), `IconButton` (an
    icon-only square with a tooltip; `iconButton()` gives a link the same
    look), `CopyButton`.
  - Fields: `Input`, `PasswordInput`, `Textarea`, `NumberInput`, `Select` (a
    Radix list styled like a field; `options` takes plain options and
    `{ group, options }`; an option worth `""` is allowed), `Switch`,
    `Segmented`, `Field`. The class `field` is the look of every field, for
    the few that are built elsewhere.
  - State: `Status` (dot and word, no ground) for what is fine or neutral;
    `Badge` (tinted ground, no border; `mono` for a machine value) for a
    category or a problem that needs a look; `State` picks between them by
    tone (`warn` and `err` become a `Badge`). `Dot` is the bare LED. `Meter`
    is a continuous thin bar of a limit in use.
  - Containers: `Panel`, `Row`, `Section` (folds away, shows its values in
    the header), `Tabs`, `ChoiceList` / `Choice`, `Table` / `Th` / `Td`.
  - Figures: `StatGrid` and `Stat`, the headline numbers of the overview and
    of a call.
  - Feedback: `Empty` (an icon in a tinted circle, a title, an optional action;
    `size="page"` fills a pane), `Notice` (a tinted strip, no border),
    `Skeleton` and `Loading` (the shape of what is on its way, instead of a
    spinner in an empty box), `Spinner` (inside a control only), `Kbd`.
  - `Info` is the ⓘ beside a label (`Row`, `Field` and `Panel` take it as
    `info`). It opens on hover with a mouse and on tap on a touch screen;
    `Tooltip` does not open on touch, so anything the user needs to read goes
    in `Info`. With `trigger` it opens on another element instead of an ⓘ,
    such as a disabled control whose reason it gives.- `overlays.tsx` — `Dialog`, `Drawer`, `Popover`, toasts (`useToast`),
  confirmation (`useConfirm`). Behavior comes from unstyled Radix primitives;
  the styling is ours.
- `inputs.tsx` — `RateLimitInput`, `SecretInput`, `JSONInput`, `ChipInput`,
  `CodeSelect` (a country or language, named in Chinese).
- `brand.tsx` — `BrandIcon`, a provider's (or a built-in rule's site) logo.
  The one place colors outside the tokens are allowed.
- `markdown.tsx` — `Markdown` for untrusted long text: no raw HTML, images
  become links.
- `components/` — `ProviderName` (use it wherever a provider is named),
  `RouteList` (numbered priority lanes), `ProviderPicker`, `ModelPicker`.
- `components/flow/` — one call drawn from its trace (`lib/trace.ts`), the
  same for a stored call, a call in flight and a playground call. A pill is a
  decision that took no time; a card is something called and timed. Parallel
  work forks into columns; a dropped branch is dashed. The signal color marks
  only what is running now. Wording lives in `wording.ts`.
- `pages/Report.tsx` — the public report page: the same tokens at reading
  scale (`report-backdrop`, `md-report`).
- `pages/play/kit.tsx` — the playground: `Stage` (input column and output
  pane, stacked below `xl`), `Composer`, `Output`, `Recent`. Composer contents
  lay out by container (`@` variants), not by window width. A chip whose
  value differs from the configuration carries a signal dot, and a section of
  settings that only the playground can send carries one `仅调试台` tag;
  nothing else repeats it.

## Rules

- At most one primary button per view.
- Do not add a color, radius, font size or shadow outside the tokens. If a
  design needs one, add a token and document it here. `mise run lint:design`
  (part of `mise run lint`) fails on an arbitrary radius, shadow or font size
  and on a hex color anywhere in `src/` but `ui/brand.tsx`.
- Panels are not numbered and titles carry no prefix.
- A state that is fine is a `Status`; a `Badge` is a category or a problem.
- Loading shows a `Skeleton` or `Loading` of the content's shape.
- Destructive actions use the `danger` button and go through `useConfirm`.
- Secrets are never rendered; `SecretInput` shows only the stored hint.
- The console is used on a phone: below `md` the sidebar becomes a top bar
  and a drawer, heights use `dvh`, fields are 16px on touch screens so the
  page does not zoom, and nothing overflows horizontally.
