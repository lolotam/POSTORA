/**
 * How a comment is coloured by how deep it sits in its thread.
 *
 * The colour is the only thing telling a reader that one comment answers another, so
 * the levels have to stay visually distinct rather than shade into each other, and each
 * has to hold on both themes -- hence the explicit dark variants rather than an opacity
 * ramp, which washes out to the same grey by the third level on a dark ground.
 */
export interface DepthStyle {
  /** Vertical rail down the left of the comment. Logical side, so it flips under RTL. */
  rail: string;
  /** Very light wash behind the comment body. */
  tint: string;
  /** Author name, so the level reads even when the rail is off-screen on mobile. */
  name: string;
}

const DEPTH_STYLES: DepthStyle[] = [
  { rail: "bg-primary", tint: "bg-primary/[0.04]", name: "text-foreground" },
  { rail: "bg-neutral-900 dark:bg-neutral-800", tint: "bg-sky-500/[0.06]", name: "text-foreground dark:text-neutral-200" },
  { rail: "bg-neutral-900 dark:bg-neutral-800", tint: "bg-violet-500/[0.06]", name: "text-foreground dark:text-neutral-200" },
  { rail: "bg-amber-500", tint: "bg-amber-500/[0.07]", name: "text-amber-700 dark:text-amber-300" },
  { rail: "bg-emerald-500", tint: "bg-emerald-500/[0.06]", name: "text-emerald-700 dark:text-emerald-300" },
];

/** Cycles past the deepest defined level, so an unusually long chain still renders. */
export function depthStyle(depth: number): DepthStyle {
  return DEPTH_STYLES[depth % DEPTH_STYLES.length];
}

const INDENT_REM = 1.25;
// Past this the text column is too narrow to read on a phone, so deeper replies keep
// the last indent and rely on the rail colour alone.
const MAX_INDENT_DEPTH = 4;

/** Logical inset for a reply, so Arabic threads indent from the right. */
export function depthIndent(depth: number): string {
  return `${Math.min(depth, MAX_INDENT_DEPTH) * INDENT_REM}rem`;
}
