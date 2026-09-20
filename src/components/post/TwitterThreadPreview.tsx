import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Twitter, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TwitterThreadPreviewProps {
  caption: string;
  username?: string;
  avatarUrl?: string;
}

// Split text into tweet-sized chunks while respecting word boundaries
export function splitIntoTweets(text: string, maxLength: number = 280): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const tweets: string[] = [];
  let remainingText = text;
  let tweetIndex = 1;

  while (remainingText.length > 0) {
    // Reserve space for thread indicator (e.g., "1/5 " = 4 chars max for reasonable threads)
    const threadIndicatorSpace = 6; // "XX/XX " format
    const effectiveMaxLength = maxLength - threadIndicatorSpace;

    if (remainingText.length <= effectiveMaxLength) {
      tweets.push(remainingText.trim());
      break;
    }

    // Find a good break point (prefer sentence/paragraph, then word boundary)
    let breakPoint = effectiveMaxLength;

    // Try to break at paragraph
    const paragraphBreak = remainingText.lastIndexOf('\n\n', effectiveMaxLength);
    if (paragraphBreak > effectiveMaxLength * 0.5) {
      breakPoint = paragraphBreak;
    } else {
      // Try to break at sentence
      const sentenceEnders = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let lastSentenceEnd = -1;
      for (const ender of sentenceEnders) {
        const idx = remainingText.lastIndexOf(ender, effectiveMaxLength);
        if (idx > lastSentenceEnd && idx > effectiveMaxLength * 0.4) {
          lastSentenceEnd = idx + ender.length - 1;
        }
      }

      if (lastSentenceEnd > effectiveMaxLength * 0.4) {
        breakPoint = lastSentenceEnd;
      } else {
        // Break at word boundary
        const lastSpace = remainingText.lastIndexOf(' ', effectiveMaxLength);
        if (lastSpace > effectiveMaxLength * 0.3) {
          breakPoint = lastSpace;
        }
      }
    }

    const chunk = remainingText.substring(0, breakPoint).trim();
    tweets.push(chunk);
    remainingText = remainingText.substring(breakPoint).trim();
    tweetIndex++;

    // Safety check to prevent infinite loops
    if (tweetIndex > 25) {
      if (remainingText.length > 0) {
        tweets.push(remainingText);
      }
      break;
    }
  }

  return tweets;
}

// Add thread numbers to tweets
export function addThreadNumbers(tweets: string[]): string[] {
  if (tweets.length <= 1) return tweets;
  
  return tweets.map((tweet, index) => {
    const threadIndicator = `${index + 1}/${tweets.length}`;
    // Add thread indicator at the start
    return `${threadIndicator} ${tweet}`;
  });
}

export function TwitterThreadPreview({
  caption,
  username = "username",
  avatarUrl,
}: TwitterThreadPreviewProps) {
  const { t } = useTranslation("postpreview");
  const tweets = splitIntoTweets(caption);
  const numberedTweets = addThreadNumbers(tweets);

  if (tweets.length <= 1) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Twitter className="w-4 h-4 text-[#1DA1F2]" />
          <span className="text-sm font-medium">{t("twitterThread.previewTitle", "Thread Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs">
          {t("twitterThread.tweetsCount", { count: tweets.length, defaultValue: `${tweets.length} tweets` })}
        </Badge>
      </div>

      <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
        {numberedTweets.map((tweet, index) => (
          <div key={index} className="relative">
            {/* Thread connector line */}
            {index < numberedTweets.length - 1 && (
              <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-border -mb-3" />
            )}
            
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="flex gap-3">
                  {/* Avatar */}
                  <div className="shrink-0">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Twitter className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {/* Tweet content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm truncate">@{username}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {index + 1}/{tweets.length}
                      </Badge>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                      {tweet}
                    </p>
                    <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                      <span>{t("twitterThread.charsCount", { count: tweet.length, defaultValue: `${tweet.length} chars` })}</span>
                      {tweet.length > 280 && (
                        <Badge variant="destructive" className="text-[10px] ml-2">
                          {t("twitterThread.overLimit", "Over limit!")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      {/* Thread summary */}
      <Separator className="my-3" />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Link2 className="w-3 h-3" />
          <span>{t("twitterThread.replyChainHint", "Tweets will be posted as a reply chain")}</span>
        </div>
        <span>{t("twitterThread.totalChars", { count: caption.length, defaultValue: `Total: ${caption.length} characters` })}</span>
      </div>
    </div>
  );
}
