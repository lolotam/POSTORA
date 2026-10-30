import { Fragment } from "react";
import { Trans, useTranslation } from "react-i18next";

import { LtrValue } from "./LtrValue";

/**
 * The weekly rate, with only the number isolated as left-to-right.
 *
 * The unit is a word and follows the document direction. Wrapping the
 * whole phrase in `dir="ltr"` paints Arabic "3.0 / أسبوع" from the left,
 * so a reader who starts on the right meets the unit first. English stays
 * `3.0/week`: the default has no space around the slash.
 */
export function PostsPerWeekValue({ value }: { value: string }) {
  const { t } = useTranslation("analytics");

  return (
    <Trans
      t={t}
      ns="analytics"
      parent={Fragment}
      i18nKey="competitors.postsPerWeekValue"
      defaults="<rate>{{value}}</rate>/week"
      values={{ value }}
      components={{
        // Trans replaces this placeholder with the formatted number.
        rate: <LtrValue>{null}</LtrValue>,
      }}
    />
  );
}
