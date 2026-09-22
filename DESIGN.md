---
name: Even
description: Sealed-bid fair launches on Monad, staged as a two-player arcade cabinet in Monad's colours.
colors:
  cabinet-indigo: "#200052"
  cabinet-deep: "#140033"
  night-black: "#0E100F"
  monad-purple: "#6E54FF"
  purple-lamp: "#8270FF"
  purple-glow: "#B5A8FF"
  berry: "#A0055D"
  berry-lamp: "#E0358F"
  marquee-white: "#FBFAF9"
  bezel-grey: "#EDEBE8"
  ink: "#17142B"
  ink-soft: "#4A4566"
  win-lime: "#C6F24E"
  berry-wash: "#FBE6F0"
  purple-wash: "#ECE8FF"
  purple-mist: "#E2DEFA"
  screen-line: "#2D1A66"
  screen-dim: "#6D5FB0"
  screen-label: "#8B7FD0"
  berry-shade: "#6D023F"
  purple-shade: "#4A36C9"
  ok-ink: "#2C6A00"
  warn-ink: "#8A4B00"
  warn-lamp: "#FFC46B"
  placeholder: "#6F6A88"
typography:
  display:
    fontFamily: "'Jersey 10', 'Silkscreen', ui-monospace, monospace"
    fontSize: "clamp(3rem, 8vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "0.01em"
  headline:
    fontFamily: "'Jersey 10', ui-monospace, monospace"
    fontSize: "clamp(2rem, 4vw, 3rem)"
    fontWeight: 400
    lineHeight: 0.95
  body:
    fontFamily: "'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Silkscreen', ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "0.06em"
  data:
    fontFamily: "'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
typeScale:
  micro: "0.625rem"
  label-sm: "0.6875rem"
  label: "0.75rem"
  small: "0.875rem"
  body-sm: "0.9375rem"
  body: "1.0625rem"
  lead: "1.1875rem"
  title-sm: "1.5rem"
  title: "1.75rem"
  panel: "2rem"
  score: "2.6rem"
rounded:
  none: "0px"
  pixel: "4px"
spacing:
  px: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  xxl: "72px"
components:
  button-coin:
    backgroundColor: "{colors.berry}"
    textColor: "{colors.marquee-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pixel}"
    padding: "14px 22px"
  button-coin-hover:
    backgroundColor: "{colors.berry-lamp}"
  button-start:
    backgroundColor: "{colors.monad-purple}"
    textColor: "{colors.marquee-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pixel}"
    padding: "14px 22px"
  button-start-hover:
    backgroundColor: "{colors.purple-lamp}"
  button-panel:
    backgroundColor: "{colors.marquee-white}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pixel}"
    padding: "12px 18px"
  card-bezel:
    backgroundColor: "{colors.marquee-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "24px"
  input-panel:
    backgroundColor: "{colors.bezel-grey}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 14px"
---

# Design System: Even

## Overview

**Creative North Star: "The Two-Player Cabinet"**

Even is staged as an arcade cabinet built in Monad's own colours. The screen is deep Monad indigo; the bezels and control panels are Monad's off-white; the two players are colour-coded, berry for the bonding curve (Player 1, where the bot wins the race) and purple for Even (Player 2, where the round ends in a draw at one price). Monad's stepped pixel art, the stair motif of its identity program, becomes literal here: it is the staircase of demand, one step per price level, and the clearing price is the step where it meets the supply.

The arcade gives the product's mechanism rituals people already know: insert a coin (the uniform deposit), your move is hidden, CONTINUE? counts down (reveal or lose the coin), RESULTS are called once for everyone, then COLLECT. The cabinet voice lives in headings, lamps, states and one authored animation; money details, forms and numbers stay calm, grotesk and legible. It is loud where it teaches and quiet where people pay.

**Key Characteristics:**
- Committed colour: indigo owns the field; off-white panels sit on it like cabinet bezels; purple and berry are the two players, never decoration.
- Hard pixel geometry: square corners, stepped edges, 4px pixel units; no soft rounded cards, no glassmorphism.
- Depth by offset, not glow: panels cast a hard stepped shadow down-right, like a cabinet's side art.
- One authored moment per surface; state changes wipe in pixel steps only when the round's phase actually changes.

## Colors

Monad's brand palette (monad.xyz, 23 Sep 2026) remapped to cabinet roles, plus one lamp colour for a win.

### Primary
- **Monad Purple** (#6E54FF): Player 2, Even. Primary actions ("Press start"), the clearing line, the active phase lamp. Text on it is Marquee White.
- **Purple Lamp** (#8270FF) and **Purple Glow** (#B5A8FF): hover and lit states; Purple Glow is the only purple used as text on indigo, because Monad Purple is too dark there.

### Secondary
- **Berry** (#A0055D): Player 1, the bonding curve and the bot's race. Also the coin: the deposit button. Text on it is Marquee White.
- **Berry Lamp** (#E0358F): berry hover and the lit "1P" lamp; readable as text on indigo.

### Tertiary
- **Win Lime** (#C6F24E): a lit lamp only. "WIN", "DRAW", "CALLED", success confirmations, the lit phase bulb, focus on the screen. Never a fill larger than a lamp or a banner, never emphasis in prose.

### Neutral
- **Cabinet Indigo** (#200052): the screen, the page field.
- **Cabinet Deep** (#140033): recessed wells on the screen, scanline shadow, the hard offset shadow.
- **Night Black** (#0E100F): the cabinet's outer shell and footer.
- **Marquee White** (#FBFAF9): bezel panels, forms, and text on indigo.
- **Bezel Grey** (#EDEBE8): input wells and quiet rows on white panels.
- **Ink** (#17142B) and **Ink Soft** (#4A4566): text on white panels. Secondary text on indigo is Purple Glow, never grey.

### Support tones
Derived from the palette above for jobs the main colours cannot do; all live as CSS tokens in `web/styles.css`.
- **Washes on white panels:** Berry Wash (#FBE6F0) marks the bot's row and problem lists; Purple Wash (#ECE8FF) marks your own row; Purple Mist (#E2DEFA) is hover on white.
- **On the screen:** Screen Line (#2D1A66) for chart grid lines and past lamps; Screen Dim (#6D5FB0) for axes and unlit lamp text; Screen Label (#8B7FD0) for chart labels and footnotes.
- **Pixel shading:** Berry Shade (#6D023F) and Purple Shade (#4A36C9), the inner bevel of coins and icons.
- **Messages:** OK Ink (#2C6A00) and Warn Ink (#8A4B00) on white; Warn Lamp (#FFC46B) on the dark status bar. Placeholder (#6F6A88) for input hints.

### Named Rules
**The Two Players Rule.** Berry always means the bonding curve (or the coin); purple always means Even. Never swap them, never use either as decoration.

**The Lamp Rule.** Win Lime is a light, not a paint: it appears only on something that just happened (a win, a draw, a confirmation), and never on more than one element per viewport.

## Typography

**Display Font:** Jersey 10 (with Silkscreen, monospace)
**Body Font:** Schibsted Grotesk (with system sans)
**Label Font:** Silkscreen (with monospace)

**Character:** Jersey 10 is the cabinet: chunky pixel lettering for marquees, headings and the big numbers. Silkscreen is the lamp labels and buttons, always uppercase and short. Schibsted Grotesk carries every sentence, form and number someone has to read carefully.

### Hierarchy
- **Display** (400, clamp(3rem, 8vw, 6rem), 0.9): the marquee headline and the called price. Outlined (text stroke) when it plays Monad's giant outlined numeral.
- **Headline** (400, clamp(2rem, 4vw, 3rem), 0.95): section titles and panel titles.
- **Body** (400, 1.0625rem, 1.55): all prose and form labels; measure 65ch max.
- **Label** (400, 0.75rem, 0.06em, uppercase): buttons, lamps, 1P/2P markers, table headers.
- **Data** (600, 1rem): prices, amounts, deposits. Tabular figures only where digits must not jump (the countdown).

### Scale
The fixed ramp, as CSS tokens `--t-*`: micro 0.625, label-sm 0.6875, label 0.75, small 0.875, body-sm 0.9375, body 1.0625, lead 1.1875 (rem) for grotesk and Silkscreen text; title-sm 1.5, title 1.75, panel 2, score 2.6 for Jersey 10. Page headlines, the clock and the called price use clamps set where they are used.

### Named Rules
**The Readable Money Rule.** Any MON or token amount a person acts on is set in Schibsted Grotesk, never in a pixel face. Tabular figures only in the countdown and in whole-number columns; Schibsted's tabular decimals space the point apart, so prices with decimals use its default figures. Pixel faces may repeat a number for spectacle only where the same number is also shown readably.

## Layout

A single centred cabinet column, max 1180px, on the indigo field, 16px side gutters on phones. Wide tables (the bids board) scroll sideways inside their panel rather than widening the page. The landing's first viewport is the two-player screen: two equal halves side by side at ≥ 900px, stacked 1P over 2P below it. App screens use a two-column control-panel grid (main 2fr, side 1fr) that collapses to one column below 900px. Spacing steps are multiples of the 4px pixel (8, 16, 24, 40, 72), with more space above a heading than below it.

## Elevation & Depth

Flat surfaces with hard, stepped offset shadows; nothing glows. Panels cast `6px 6px 0 #140033` (Cabinet Deep) on indigo; pressed buttons lose their shadow and move 3px down-right, like a physical arcade button. The screen carries a faint scanline texture (2px repeating gradient at 4% opacity) that never sits under body text.

A panel that belongs to a player takes that player's colour in its offset shadow (berry for 1P, purple for 2P) instead of Cabinet Deep. That shadow is the only player marker a panel carries: no top or side stripes. Dividers between players and between steps are 4px gaps that show the darker field through, never borders.

The page field carries a faint two-axis pixel grid (the cabinet's playfield, 1px lines at about 2.4% white). It sits under headlines and panels only, never inside a panel.

### Named Rules
**The Offset Shadow Rule.** Depth is a hard offset with zero blur, like side art. No blurred or coloured halos.

## Shapes

Square corners everywhere except the 4px pixel radius on buttons. Panel corners are notched: one 8px pixel step cut from each corner via clip-path, the signature cabinet silhouette. Stairs, bars and icons are drawn on a pixel grid with crisp edges (SVG `shape-rendering: crispEdges`).

## Components

### Buttons
- **Shape:** pixel-radius rectangles (4px) with a 3px hard shadow.
- **Coin (berry):** the deposit action only: "Insert coin", commit.
- **Start (purple):** the primary forward action per screen: bid, reveal, seed, claim.
- **Panel (white):** secondary actions.
- **Hover / Focus:** the lamp colour lights up; focus draws a 3px pixel outline offset 2px: Win Lime on the screen, Ink on white panels (lime is invisible there). Active: shadow drops to 0 and the button moves 3px down-right.

### Cards / Containers
- **Bezel panel:** Marquee White, square with notched corners, 24px padding, the 6px Cabinet Deep offset shadow. Title in Jersey 10.
- **Screen well:** Cabinet Deep inset area for live displays (stairs, scoreboards).

### Inputs / Fields
- **Style:** Bezel Grey wells, 2px Ink border, square.
- **Focus:** border turns Monad Purple with the Ink focus outline.
- **Error:** Berry border plus a Berry message naming the problem and the fix.

### Navigation
- **Marquee bar:** the EVEN pixel logo on the left, three Silkscreen links (Play, Host a launch, How it plays), and the wallet as a coin-slot button on the right. Below 760px it stops being sticky and wraps: logo and wallet on top, the three links on their own row.

### Phase lamps
The round's four phases (Insert coin, Continue?, Results, Collect) as a row of lamps; the current one is lit (purple with a Win Lime bulb pixel above its label), past ones stay dim-lit, future ones dark.

### Charts
SVG charts are drawn in a 460×250 viewBox and scale with their container. Axis and annotation labels are Silkscreen at the micro step (0.625rem, read as viewBox units, so they scale with the chart), in Screen Label; they are annotations, never the only place a number appears.

### Demand staircase
The signature component: Monad's stepped pixel stair drawn from real price levels, with the supply line and the clearing step marked. It appears twice: in the landing replay (2P) and in a Cabinet Deep screen well at the top of a settled round's Results panel, built from the revealed bids; steps below the clearing price are Screen Dim.

## Do's and Don'ts

### Do:
- **Do** keep every fairness claim next to the thing that proves it (the staircase, the scoreboard, the real demo numbers).
- **Do** use the exact claim wording: "Snipe-resistant: submission timing no longer determines price" and "Privacy via commit-reveal".
- **Do** label replayed or simulated data with its source.

### Don't:
- **Don't** write "no sniping", "MEV-proof", "bot-proof", or mention an encrypted mempool.
- **Don't** use gradients as text, glass blur, soft rounded cards, or glowing halos.
- **Don't** set money amounts in a pixel face (the Readable Money Rule).
- **Don't** use Win Lime as a background fill.
