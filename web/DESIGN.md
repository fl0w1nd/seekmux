# Signal — the SeekMux design system

Signal is the interface system of the SeekMux console. It is built for one
job: operating a gateway. The screen shows machine facts (latencies, quotas,
routes, keys) and a small number of settings, so the system is dense, flat and
quiet, with a single loud color reserved for what matters right now.

The living reference is the `/design` page of the console (`src/pages/Design.tsx`),
which renders every token and component. Tokens live in `src/styles/index.css`;
components in `src/ui/`.

## Principles

1. **One signal.** There is exactly one brand color, a lime. It marks the
   primary action on a screen and things that are live. It is never decoration.
2. **Flat hierarchy.** Depth is expressed with lightness steps and 1px lines.
   Shadows exist only on things that actually float (dialogs, drawers, toasts,
   tooltips).
3. **Machine text is mono.** Anything a machine produced or will consume —
   numbers, durations, IDs, URLs, keys, model names — is set in IBM Plex Mono
   with tabular figures (`num`). Everything a person reads is IBM Plex Sans.
4. **State is a dot plus a word.** Never color alone. A breathing dot means
   "happening at this moment" and nothing else.
5. **Settings are rows, data is tables.** A setting says what it is on the
   left and holds its control on the right.
6. **The interface shows; it does not explain.** A label, a value and a
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
| Surfaces | `bg` `surface` `raised` `sunken` `overlay` | page, panel, hover/selected, inputs and code, floating layers |
| Lines | `line` `line-strong` | separators and containers; controls and overlays |
| Text | `ink` `ink-2` `ink-3` | primary, secondary, captions and placeholders |
| Brand | `signal` `signal-hover` `signal-ink` `signal-text` | fill, hover fill, text on the fill, brand-colored text on a surface |
| Status | `ok` `warn` `err` `info` | kept off the brand hue so success never reads as brand |

Neutrals carry a slight green tint (hue 112–150) so they belong with the
signal color instead of sitting next to it as plain gray.

**Type.** Seven sizes, each with a fixed line height: `2xs` 11, `xs` 12,
`sm` 13, `base` 14, `lg` 16, `xl` 20, `2xl` 28. Body is `base`; controls and
tables are `sm`. Two display sizes, `3xl` 36 and `4xl` 52, are for the report
page only. Two utilities: `num` (mono, tabular) and `tag` (mono, 11px,
uppercase, tracked — the micro label on panels, columns and lanes).

**Shape.** Two radii only: `rounded-ctl` (5px) for controls, `rounded-panel`
(10px) for containers. Controls are 32px tall, 28px in dense places.

**Motion.** 140ms ease-out for entering layers, 200ms for the drawer. Folding
regions (`animate-fold-down` / `animate-fold-up`) and moving quantities
(`useTween` in `lib/motion.ts`) use `ease-settle`. New bars grow from their
baseline (`animate-grow-x` / `animate-grow-y`); a row arriving in a live list
fades in once (`animate-arrive`). Motion only shows a change of state; nothing
loops except the dot of something live. All of it is off under
`prefers-reduced-motion`.

## Components

- `primitives.tsx` — `Button` (primary / secondary / ghost / danger), `Input`,
  `Textarea`, `Select`, `NumberInput`, `Switch`, `Segmented`, `Field`, `Dot`,
  `Badge`, `Panel`, `Row`, `Section` (folds away, shows its values in the
  header), `Tabs`, `ChoiceList` / `Choice`, `Empty`, `Notice`, `Meter`,
  `CodeBlock`, `Tooltip`, `Info`, `Table`.
  - `Info` is the ⓘ beside a label (`Row`, `Field` and `Panel` take it as
    `info`). It opens on hover with a mouse and on tap on a touch screen;
    `Tooltip` does not open on touch, so anything the user needs to read goes
    in `Info`. With `trigger` it opens on another element instead of an ⓘ,
    such as a disabled control whose reason it gives.
- `overlays.tsx` — `Dialog`, `Drawer`, `Popover`, toasts (`useToast`),
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
  design needs one, add a token and document it here.
- Panels are numbered (`01`, `02`…) in reading order.
- Destructive actions use the `danger` button and go through `useConfirm`.
- Secrets are never rendered; `SecretInput` shows only the stored hint.
- The console is used on a phone: below `md` the sidebar becomes a top bar
  and a drawer, heights use `dvh`, fields are 16px on touch screens so the
  page does not zoom, and nothing overflows horizontally.
