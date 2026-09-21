import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

const DEFAULT_TAGLINE =
  "Postora helps creators and marketers schedule, create, and publish content across Instagram, YouTube, TikTok, LinkedIn, and 7 more platforms — all from one beautiful dashboard.";

export function TypingTagline() {
  const { t } = useTranslation("dashboard");
  const tagline = t("header.tagline", DEFAULT_TAGLINE);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setCharIndex(0);
    setIsDeleting(false);
  }, [tagline]);

  useEffect(() => {
    if (!isDeleting && charIndex >= tagline.length) {
      const pause = setTimeout(() => setIsDeleting(true), 2000);
      return () => clearTimeout(pause);
    }
    if (isDeleting && charIndex === 0) {
      const pause = setTimeout(() => setIsDeleting(false), 500);
      return () => clearTimeout(pause);
    }
    const speed = isDeleting ? 15 : 40;
    const timer = setTimeout(
      () => setCharIndex((i) => i + (isDeleting ? -1 : 1)),
      speed
    );
    return () => clearTimeout(timer);
  }, [charIndex, isDeleting, tagline.length]);

  return (
    <div className="max-w-2xl mt-2">
      <p className="text-sm font-medium tracking-wide bg-gradient-to-r from-primary via-purple-500 to-pink-500 bg-clip-text text-transparent inline">
        {tagline.slice(0, charIndex)}
      </p>
      <span className="inline-block w-[2px] h-4 ms-0.5 bg-primary animate-pulse align-text-bottom" />
    </div>
  );
}
