import type { ReactNode } from "react";

/**
 * A number isolated as left-to-right.
 *
 * In an RTL page the bidi algorithm moves a leading sign to the other
 * side of the digits, so "+480" is painted as "480+". Isolating the
 * value keeps the sign on the left. `bdi` is an isolate on its own;
 * `dir` fixes the direction inside it.
 */
export function LtrValue({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}
