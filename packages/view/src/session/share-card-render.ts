// The share card's drawing: a 1200x630 canvas, the size
// social sites preview, in the product's teal with white
// and pale text. The only strings it draws are the fixed
// labels, the numbers, the kind phrases and the repo
// address — cardTextLines lists them all, in draw order,
// so a test can hold the card to that: no path, file name,
// title, prompt text, model name or date can appear,
// because none is ever handed to this module.

import {
  formatCount,
  formatDuration,
  formatTokens,
} from "@flightpath/flightpath/format";

import { PLANE_BODY_PATH, PLANE_LINE_PATH } from "../components/icons.js";
import { countWord } from "../counts.js";
import type { CardNumbers } from "./share-card-numbers.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const FONT = "Geist, system-ui, sans-serif";

/** The card's colours, read from the stylesheet's tokens
 * like every other colour in the view; the card is the
 * same in both themes, so its tokens stand outside the
 * light-dark pairs. */
interface CardPalette {
  bg: string;
  ink: string;
  pale: string;
  line: string;
}

function cardPalette(): CardPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  return {
    bg: read("--share-bg"),
    ink: read("--share-ink"),
    pale: read("--share-pale"),
    line: read("--share-line"),
  };
}

const HEADING = "My Claude Code session, in numbers";
const REPO_ADDRESS = "github.com/dk-labs-dev/flightpath";

interface NumberBlock {
  label: string;
  value: string;
}

function promptsBlock(numbers: CardNumbers): NumberBlock | null {
  if (numbers.promptsTokens === null) {
    return null;
  }
  return {
    label: "My prompts",
    value: `about ${formatCount(numbers.promptsTokens)} tokens`,
  };
}

function contextBlock(numbers: CardNumbers): NumberBlock | null {
  if (numbers.contextTokens === null) {
    return null;
  }
  return {
    label: "What Claude Code was carrying",
    value: `${formatCount(numbers.contextTokens)} tokens`,
  };
}

function riseBlock(numbers: CardNumbers): NumberBlock | null {
  const rise = numbers.biggestRise;
  if (rise === null) {
    return null;
  }
  const size = `+${formatCount(rise.tokens)} tokens`;
  return {
    label: "Biggest jump",
    value: rise.kind === null ? size : `${size} · ${rise.kind}`,
  };
}

/** The card's duration, in whole minutes as the card
 * words it; a session under a minute keeps the view's own
 * duration words rather than reading "0 min". */
function durationText(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60_000);
  return minutes >= 1
    ? `${formatCount(minutes)} min`
    : formatDuration(durationMs);
}

/** The line under the divider: the duration, the steps and
 * the overhead, each present only when the view has it. */
function bottomLine(numbers: CardNumbers): string | null {
  const parts: string[] = [];
  if (numbers.durationMs !== null) {
    parts.push(durationText(numbers.durationMs));
  }
  if (numbers.steps !== null) {
    parts.push(
      `${formatCount(numbers.steps)} ${countWord(numbers.steps, "step", "steps")}`,
    );
  }
  if (numbers.overheadTokens !== null) {
    parts.push(`Flightpath added ${formatTokens(numbers.overheadTokens)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Every string the card draws, in draw order. */
export function cardTextLines(numbers: CardNumbers): string[] {
  const lines: string[] = [HEADING];
  for (const block of [promptsBlock(numbers), contextBlock(numbers)]) {
    if (block !== null) {
      lines.push(block.label, block.value);
    }
  }
  const rise = riseBlock(numbers);
  if (rise !== null) {
    lines.push(rise.label, rise.value);
  }
  const bottom = bottomLine(numbers);
  if (bottom !== null) {
    lines.push(bottom);
  }
  lines.push("flightpath", REPO_ADDRESS);
  return lines;
}

function drawPlane(
  ctx: CanvasRenderingContext2D,
  palette: CardPalette,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 1.7;
  ctx.lineJoin = "round";
  const body = new Path2D(PLANE_BODY_PATH);
  ctx.fillStyle = palette.ink;
  ctx.strokeStyle = palette.ink;
  ctx.fill(body);
  ctx.stroke(body);
  ctx.strokeStyle = palette.bg;
  ctx.stroke(new Path2D(PLANE_LINE_PATH));
  ctx.restore();
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  palette: CardPalette,
  block: NumberBlock,
  x: number,
  labelY: number,
  valueFont: string,
  valueY: number,
): void {
  ctx.fillStyle = palette.pale;
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText(block.label, x, labelY);
  ctx.fillStyle = palette.ink;
  ctx.font = valueFont;
  ctx.fillText(block.value, x, valueY);
}

/** The big numbers' shared size: 80px, stepped down until
 * the wider of the two fits its column, so the pair always
 * stands at one size and neither runs into the other or
 * off the card. */
function bigValueFont(
  ctx: CanvasRenderingContext2D,
  blocks: NumberBlock[],
): string {
  const widths = [520, 488];
  let size = 80;
  while (size > 40) {
    ctx.font = `700 ${size}px ${FONT}`;
    const fits = blocks.every(
      (block, index) =>
        ctx.measureText(block.value).width <= (widths[index] ?? 488),
    );
    if (fits) {
      break;
    }
    size -= 4;
  }
  return `700 ${size}px ${FONT}`;
}

/** Draw the card for these numbers onto a 1200x630 canvas. */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  numbers: CardNumbers,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return;
  }
  const palette = cardPalette();
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  drawPlane(ctx, palette, 72, 52, 54);
  ctx.fillStyle = palette.ink;
  ctx.font = `600 38px ${FONT}`;
  ctx.fillText(HEADING, 146, 96);

  const blocks = [promptsBlock(numbers), contextBlock(numbers)].filter(
    (block): block is NumberBlock => block !== null,
  );
  const valueFont = bigValueFont(ctx, blocks);
  blocks.forEach((block, index) => {
    drawBlock(ctx, palette, block, index === 0 ? 72 : 640, 224, valueFont, 312);
  });

  const rise = riseBlock(numbers);
  const bottom = bottomLine(numbers);
  if (rise !== null || bottom !== null) {
    ctx.fillStyle = palette.line;
    ctx.fillRect(72, 372, CARD_WIDTH - 144, 2);
  }
  if (rise !== null) {
    drawBlock(ctx, palette, rise, 72, 446, `600 44px ${FONT}`, 508);
  }
  if (bottom !== null) {
    ctx.fillStyle = palette.pale;
    ctx.font = `28px ${FONT}`;
    ctx.fillText(bottom, 72, 560);
  }

  ctx.fillStyle = palette.ink;
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText("flightpath", 72, 606);
  ctx.fillStyle = palette.pale;
  ctx.font = `24px ${FONT}`;
  const address = REPO_ADDRESS;
  ctx.fillText(address, CARD_WIDTH - 72 - ctx.measureText(address).width, 606);
}
