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
   left and holds its control on the right. Explanations sit next to the thing
   they explain, in one sentence.

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
tables are `sm`. Two utilities: `num` (mono, tabular) and `tag` (mono, 11px,
uppercase, tracked — the micro label on panels, columns and lanes).

**Shape.** Two radii only: `rounded-ctl` (5px) for controls, `rounded-panel`
(10px) for containers. Controls are 32px tall, 28px in dense places.

**Motion.** 140ms ease-out for entering layers, 200ms for the drawer. A region
that folds open (`animate-fold-down` / `animate-fold-up`) and a quantity that
moves to a new value (a gauge bar, a number followed with `useTween` from
`lib/motion.ts`) use `ease-settle`, which arrives fast and comes to rest
without overshoot. Motion only ever shows a change of state; nothing loops
except the dot of something that is live. All of it is disabled under
`prefers-reduced-motion`.

## Components

- `primitives.tsx` — `Button` (primary / secondary / ghost / danger), `Input`,
  `Textarea`, `Select`, `NumberInput`, `Switch`, `Segmented`, `Field`, `Dot`,
  `Badge`, `Panel`, `Row`, `Section` (a group that folds away and shows its
  current values in the header), `Tabs` / `TabList` / `TabPanel`,
  `ChoiceList` / `Choice` (a short list of options, one chosen, each with a
  status), `Empty`,
  `Notice`, `Meter`, `CodeBlock`, `Tooltip`, `Table`.
- `overlays.tsx` — `Dialog`, `Drawer`, `Popover` (a few choices or a note
  anchored to the control that opens it), toasts (`useToast`), confirmation
  (`useConfirm`). Behavior and accessibility come from unstyled Radix
  primitives; every pixel of styling is ours.
- `inputs.tsx` — `RateLimitInput`, `SecretInput`, `JSONInput`, `ChipInput`
  (a short list of words such as domains).
- `markdown.tsx` — `Markdown`, for long text from providers and models. It
  never renders raw HTML and turns images into links, since the text is
  untrusted.
- `components/` — `RouteList` (numbered priority lanes), `ModelRefEditor`,
  `ProviderPicker` (auto or one provider, with its health), `ModelOverride`
  (the assigned models or another one, for a single call),
  `Waterfall` (the upstream calls of one request on a shared time axis).
- `pages/play/kit.tsx` — what the playground pages are built from: `Stage`
  (the page head and the hairline frame the composer stands on), `Composer`
  (the main input, a bar of `Chip`s that name a setting and show its value,
  and a parameter panel that folds open), `Output` (the pane a call answers
  into, with its result and its upstream calls), `Recent` (past runs, a click
  takes their arguments back). A chip carries a signal dot when its value is
  not the configured one, and whatever applies to one call only is marked
  `仅调试台`.

## Rules

- At most one primary button per view.
- Do not add a color, radius, font size or shadow outside the tokens. If a
  design needs one, add a token and document it here.
- Panels are numbered (`01`, `02`…) in reading order; the number is a `tag` in
  the signal text color.
- Destructive actions use the `danger` button and go through `useConfirm`.
- A control made of several buttons (`Segmented`, `ChipInput`,
  `ProviderPicker`) is never put inside `Field`: `Field` is a `<label>`, and a
  click on its text would press the first button.
- Secrets are never rendered; `SecretInput` shows only the stored hint.
- Every state has copy: empty states say what will appear and how to get it
  there, errors say what happened and what to do.
