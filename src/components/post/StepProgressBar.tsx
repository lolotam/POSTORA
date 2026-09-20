import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export type PostStep = 1 | 2 | 3;

interface StepProgressBarProps {
  currentStep: PostStep;
  onStepChange: (step: PostStep) => void;
}

export function StepProgressBar({ currentStep, onStepChange }: StepProgressBarProps) {
  const { t } = useTranslation("post");

  const steps = [
    { number: 1 as PostStep, label: t("steps.content", "Content") },
    { number: 2 as PostStep, label: t("steps.platforms", "Platforms") },
    { number: 3 as PostStep, label: t("steps.schedule", "Schedule") },
  ];

  return (
    <div className="flex items-center justify-center w-full max-w-md mx-auto py-3" style={{ perspective: '600px' }}>
      {steps.map((step, index) => {
        const isCompleted = currentStep > step.number;
        const isActive = currentStep === step.number;
        const isClickable = step.number <= currentStep;

        return (
          <div key={step.number} className="flex items-center flex-1 last:flex-initial">
            {/* Step circle + label */}
            <button
              type="button"
              onClick={() => isClickable && onStepChange(step.number)}
              disabled={!isClickable}
              className="flex flex-col items-center gap-1.5 group transition-transform duration-300"
              style={{
                transform: isActive ? 'translateY(-2px) scale(1.08)' : 'translateY(0) scale(1)',
              }}
            >
              <div
                className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 border-2",
                  isCompleted
                    ? "bg-primary border-primary text-primary-foreground"
                    : isActive
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-card border-border text-muted-foreground"
                )}
                style={{
                  boxShadow: isActive
                    ? '0 6px 20px -4px hsl(var(--primary) / 0.45), 0 2px 6px -1px hsl(var(--primary) / 0.2)'
                    : isCompleted
                      ? '0 3px 10px -3px hsl(var(--primary) / 0.3)'
                      : '0 2px 8px -2px hsl(var(--border) / 0.5)',
                }}
              >
                {isCompleted ? <Check className="w-4 h-4" /> : step.number}
              </div>
              <span
                className={cn(
                  "text-xs font-medium transition-colors",
                  isActive || isCompleted ? "text-primary" : "text-muted-foreground"
                )}
              >
                {step.label}
              </span>
            </button>

            {/* Connecting line */}
            {index < steps.length - 1 && (
              <div className="flex-1 h-0.5 mx-3 mt-[-1.25rem] rounded-full overflow-hidden bg-border">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    isCompleted ? "w-full bg-primary" : "w-0 bg-primary"
                  )}
                  style={{
                    boxShadow: isCompleted ? '0 0 8px hsl(var(--primary) / 0.4)' : 'none',
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
