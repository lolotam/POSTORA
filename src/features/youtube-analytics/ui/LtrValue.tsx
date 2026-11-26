import type { ReactNode } from "react";

export function LtrValue({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}
