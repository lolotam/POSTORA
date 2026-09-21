import { useTranslation } from "react-i18next";
import "@/i18n";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BehaviorCardProps } from "./types";

/** Matches MAX_BLOCKS in supabase/functions/_shared/agentBehavior.ts, which rejects more. */
const MAX_BLOCKS = 10;

export function InstructionBlocksCard({ behavior, updateBehavior }: BehaviorCardProps) {
  const { t } = useTranslation("agent");
  const blocks = behavior.instruction_blocks ?? [];

  const setBlock = (index: number, patch: { title?: string; body?: string }) =>
    updateBehavior(
      "instruction_blocks",
      blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("instructions.title", "Advanced instruction blocks")}</CardTitle>
        <CardDescription>
          {t("instructions.description", "Named rules for specific situations. Each is given to the assistant under its own heading.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {blocks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("instructions.empty", "No blocks yet. Useful for things like how to talk about pricing, or how to handle a return request.")}
          </p>
        )}
        {blocks.map((block, index) => (
          <div key={index} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start gap-2">
              <Input
                aria-label={t("instructions.titleAria", "Block {{n}} title", { n: index + 1 })}
                value={block.title}
                onChange={(event) => setBlock(index, { title: event.target.value })}
                placeholder={t("instructions.titlePlaceholder", "Pricing")}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("instructions.removeBlock", "Remove block {{n}}", { n: index + 1 })}
                onClick={() =>
                  updateBehavior(
                    "instruction_blocks",
                    blocks.filter((_, i) => i !== index),
                  )
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <Textarea
              aria-label={t("instructions.bodyAria", "Block {{n}} instructions", { n: index + 1 })}
              value={block.body}
              onChange={(event) => setBlock(index, { body: event.target.value })}
              rows={3}
              placeholder={t("instructions.bodyPlaceholder", "Never quote a price without checking the connector first.")}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocks.length >= MAX_BLOCKS}
          onClick={() => updateBehavior("instruction_blocks", [...blocks, { title: "", body: "" }])}
        >
          <Plus className="me-1 h-4 w-4" /> {t("instructions.add", "Add an instruction block")}
        </Button>
        {blocks.length >= MAX_BLOCKS && (
          <p className="text-xs text-muted-foreground">
            {t("instructions.limit", "{{count}} blocks is the limit. Merge two before adding another.", { count: MAX_BLOCKS })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
