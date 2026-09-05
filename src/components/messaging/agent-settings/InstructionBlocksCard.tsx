import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BehaviorCardProps } from "./types";

/** Matches MAX_BLOCKS in supabase/functions/_shared/agentBehavior.ts, which rejects more. */
const MAX_BLOCKS = 10;

export function InstructionBlocksCard({ behavior, updateBehavior }: BehaviorCardProps) {
  const blocks = behavior.instruction_blocks ?? [];

  const setBlock = (index: number, patch: { title?: string; body?: string }) =>
    updateBehavior(
      "instruction_blocks",
      blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Advanced instruction blocks</CardTitle>
        <CardDescription>
          Named rules for specific situations. Each is given to the assistant under its own
          heading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {blocks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No blocks yet. Useful for things like how to talk about pricing, or how to handle a
            return request.
          </p>
        )}
        {blocks.map((block, index) => (
          <div key={index} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start gap-2">
              <Input
                aria-label={`Block ${index + 1} title`}
                value={block.title}
                onChange={(event) => setBlock(index, { title: event.target.value })}
                placeholder="Pricing"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove block ${index + 1}`}
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
              aria-label={`Block ${index + 1} instructions`}
              value={block.body}
              onChange={(event) => setBlock(index, { body: event.target.value })}
              rows={3}
              placeholder="Never quote a price without checking the connector first."
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
          <Plus className="mr-1 h-4 w-4" /> Add an instruction block
        </Button>
        {blocks.length >= MAX_BLOCKS && (
          <p className="text-xs text-muted-foreground">
            {MAX_BLOCKS} blocks is the limit. Merge two before adding another.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
