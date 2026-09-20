import { Palette, Image, Layers, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { ReferenceType } from "./DraggableReferenceImage";

interface ReferenceTypeTooltipProps {
  children: React.ReactNode;
  type: ReferenceType;
}

const typeIcons: Record<ReferenceType, typeof Palette> = {
  style: Palette,
  content: Image,
  "image-to-image": Layers,
};

export function ReferenceTypeTooltip({ children, type }: ReferenceTypeTooltipProps) {
  const { t } = useTranslation("postmedia");
  const Icon = typeIcons[type];

  const typeExamples: Record<ReferenceType, {
    title: string;
    description: string;
    example: {
      input: string;
      prompt: string;
      result: string;
    };
    tips: string[];
  }> = {
    style: {
      title: t("referenceTooltip.styleTitle", "Style Reference"),
      description: t("referenceTooltip.styleDesc", "Extracts the visual style, colors, lighting, and artistic mood from your reference image and applies it to your generated image."),
      example: {
        input: t("referenceTooltip.styleExampleInput", "Monet's Water Lilies painting"),
        prompt: t("referenceTooltip.styleExamplePrompt", "\"A modern city skyline\""),
        result: t("referenceTooltip.styleExampleResult", "City rendered in impressionist brushstrokes with soft pastel colors"),
      },
      tips: [
        t("referenceTooltip.styleTip1", "Best for: Art styles, color palettes, lighting moods"),
        t("referenceTooltip.styleTip2", "The AI ignores the subject and focuses on how it looks"),
        t("referenceTooltip.styleTip3", "Higher priority = stronger style influence"),
      ],
    },
    content: {
      title: t("referenceTooltip.contentTitle", "Content Reference"),
      description: t("referenceTooltip.contentDesc", "Uses the subject matter, composition, and layout from your reference while allowing different styling in the output."),
      example: {
        input: t("referenceTooltip.contentExampleInput", "Photo of a cat sitting on a windowsill"),
        prompt: t("referenceTooltip.contentExamplePrompt", "\"A cartoon character\""),
        result: t("referenceTooltip.contentExampleResult", "Cartoon character sitting on a windowsill in similar pose"),
      },
      tips: [
        t("referenceTooltip.contentTip1", "Best for: Poses, compositions, layouts, subjects"),
        t("referenceTooltip.contentTip2", "The AI copies what is shown, not how it's rendered"),
        t("referenceTooltip.contentTip3", "Great for consistent positioning across images"),
      ],
    },
    "image-to-image": {
      title: t("referenceTooltip.img2imgTitle", "Image-to-Image Transform"),
      description: t("referenceTooltip.img2imgDesc", "Transforms your reference image directly according to your prompt, preserving the core structure while applying changes."),
      example: {
        input: t("referenceTooltip.img2imgExampleInput", "Photo of a house in summer"),
        prompt: t("referenceTooltip.img2imgExamplePrompt", "\"Cover in snow, winter scene\""),
        result: t("referenceTooltip.img2imgExampleResult", "Same house now covered in snow with winter atmosphere"),
      },
      tips: [
        t("referenceTooltip.img2imgTip1", "Best for: Transformations, edits, variations"),
        t("referenceTooltip.img2imgTip2", "Preserves spatial layout and main elements"),
        t("referenceTooltip.img2imgTip3", "Use when you want to modify an existing image"),
      ],
    },
  };

  const example = typeExamples[type];

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent 
        side="top" 
        align="start" 
        className="w-80 p-0 bg-background border border-border shadow-lg"
      >
        {/* Header */}
        <div className="flex items-center gap-2 p-3 border-b border-border bg-muted/30">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h4 className="font-medium text-sm">{example.title}</h4>
          </div>
        </div>

        {/* Description */}
        <div className="p-3 border-b border-border">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {example.description}
          </p>
        </div>

        {/* Visual Example */}
        <div className="p-3 border-b border-border bg-muted/20">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
            {t("referenceTooltip.exampleLabel", "Example")}
          </p>
          <div className="flex items-center gap-2 text-xs">
            <div className="flex-1 p-2 rounded bg-background border border-border">
              <div className="text-[10px] text-muted-foreground mb-0.5">{t("referenceTooltip.referenceLabel", "Reference")}</div>
              <div className="font-medium truncate">{example.example.input}</div>
            </div>
            <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
            <div className="flex-1 p-2 rounded bg-background border border-border">
              <div className="text-[10px] text-muted-foreground mb-0.5">{t("referenceTooltip.promptLabel", "Prompt")}</div>
              <div className="font-medium truncate">{example.example.prompt}</div>
            </div>
          </div>
          <div className="mt-2 p-2 rounded bg-primary/5 border border-primary/20">
            <div className="text-[10px] text-primary mb-0.5">{t("referenceTooltip.resultLabel", "Result")}</div>
            <div className="text-xs">{example.example.result}</div>
          </div>
        </div>

        {/* Tips */}
        <div className="p-3">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
            {t("referenceTooltip.tipsLabel", "Tips")}
          </p>
          <ul className="space-y-1">
            {example.tips.map((tip, i) => (
              <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                <span className="text-primary mt-0.5">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
