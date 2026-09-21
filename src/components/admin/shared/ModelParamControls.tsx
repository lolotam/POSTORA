/**
 * Renders the parameter controls a Higgsfield model actually declares.
 *
 * The knobs are not the same across models — GPT Image 2 has `resolution`
 * (1k/2k/4k) *and* `quality` (low/medium/high), Nano Banana has only
 * `resolution`, Soul 2.0 calls its knob `quality` but the values are 1.5k/2k,
 * and DTC Ads needs a `style_id` before it will run at all. Hardcoding one form
 * for all of them either hides options or sends parameters that fail the
 * request, so the form is built from the model's own catalog entry.
 *
 * @module components/admin/shared/ModelParamControls
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  optionLabel,
  paramLabel,
  type HiggsfieldModelSpec,
  type ModelParamSpec,
} from "@/lib/higgsfieldModelSpecs";

export type ParamValues = Record<string, string | number | boolean>;

interface ModelParamControlsProps {
  spec: HiggsfieldModelSpec;
  values: ParamValues;
  onChange: (next: ParamValues) => void;
  /** Parameters handled elsewhere in the parent form (e.g. a duration slider). */
  omit?: string[];
  disabled?: boolean;
}

export function ModelParamControls({
  spec,
  values,
  onChange,
  omit = [],
  disabled = false,
}: ModelParamControlsProps) {
  const visible = spec.parameters.filter((param) => !omit.includes(param.name));
  if (visible.length === 0) return null;

  const set = (name: string, value: string | number | boolean) =>
    onChange({ ...values, [name]: value });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {visible.map((param) => (
        <ParamControl
          key={param.name}
          param={param}
          value={values[param.name]}
          onChange={(value) => set(param.name, value)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface ParamControlProps {
  param: ModelParamSpec;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
  disabled: boolean;
}

function ParamControl({ param, value, onChange, disabled }: ParamControlProps) {
  const id = `model-param-${param.name}`;
  const label = (
    <Label htmlFor={id} className="flex items-center gap-1">
      {paramLabel(param.name)}
      {param.required && <span className="text-destructive">*</span>}
    </Label>
  );

  if (param.type === "bool") {
    return (
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
        <div className="space-y-0.5 pe-3">
          {label}
          {param.description && (
            <p className="text-[11px] text-muted-foreground">{param.description}</p>
          )}
        </div>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </div>
    );
  }

  if (param.options && param.options.length > 0) {
    return (
      <div className="space-y-2">
        {label}
        <Select
          value={value === undefined ? undefined : String(value)}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder={`Select ${paramLabel(param.name).toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {param.options.map((option) => (
              <SelectItem key={option} value={option}>
                {optionLabel(param.name, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {param.description && (
          <p className="text-[11px] text-muted-foreground">{param.description}</p>
        )}
      </div>
    );
  }

  if (param.type === "number") {
    return (
      <div className="space-y-2">
        {label}
        <Input
          id={id}
          type="number"
          dir="ltr"
          value={value === undefined ? "" : String(value)}
          min={param.min}
          max={param.max}
          // Fractional knobs like cfg_scale (0–1) need a fine step; integer
          // counts like frame_count would be unusable with one.
          step={param.max !== undefined && param.max <= 1 ? 0.1 : 1}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          disabled={disabled}
        />
        {param.description && (
          <p className="text-[11px] text-muted-foreground">{param.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {label}
      <Input
        id={id}
        dir="ltr"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.required ? "Required" : "Optional"}
        disabled={disabled}
      />
      {param.description && (
        <p className="text-[11px] text-muted-foreground line-clamp-2" title={param.description}>
          {param.description}
        </p>
      )}
    </div>
  );
}

export default ModelParamControls;
