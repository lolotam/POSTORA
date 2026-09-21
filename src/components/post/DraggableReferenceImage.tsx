import { useSortable } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { CSS } from "@dnd-kit/utilities";
import { X, GripVertical, Palette, Image, Layers, HelpCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ReferenceTypeTooltip } from "./ReferenceTypeTooltip";

export type ReferenceType = "style" | "content" | "image-to-image";

export interface ReferenceImage {
  id: string;
  url: string;
  type: ReferenceType;
}

interface DraggableReferenceImageProps {
  image: ReferenceImage;
  index: number;
  onRemove: (id: string) => void;
  onTypeChange: (id: string, type: ReferenceType) => void;
}

export function DraggableReferenceImage({
  image,
  index,
  onRemove,
  onTypeChange,
}: DraggableReferenceImageProps) {
  const { t } = useTranslation("postmedia");

  const referenceTypes = [
    { 
      value: "style" as ReferenceType, 
      label: t("referenceImage.typeStyle", "Style"), 
      icon: Palette,
      description: t("referenceImage.typeStyleDesc", "Use for artistic style, colors, mood")
    },
    { 
      value: "content" as ReferenceType, 
      label: t("referenceImage.typeContent", "Content"), 
      icon: Image,
      description: t("referenceImage.typeContentDesc", "Use for subject matter, composition")
    },
    { 
      value: "image-to-image" as ReferenceType, 
      label: t("referenceImage.typeImg2Img", "Img2Img"), 
      icon: Layers,
      description: t("referenceImage.typeImg2ImgDesc", "Transform this image with the prompt")
    },
  ];
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : "auto",
  };

  const currentType = referenceTypes.find(t => t.value === image.type);
  const TypeIcon = currentType?.icon || Palette;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group flex flex-col gap-1 ${isDragging ? "opacity-80" : ""}`}
    >
      {/* Image with drag handle */}
      <div className="relative w-16 h-16 rounded-lg overflow-hidden border border-border bg-muted">
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="absolute top-0 start-0 w-full h-5 bg-gradient-to-b from-background/80 to-transparent flex items-center justify-center cursor-grab active:cursor-grabbing z-10"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground" />
        </div>

        {/* Priority badge */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="absolute bottom-0.5 start-0.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center z-10">
                {index + 1}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t("referenceImage.priorityTooltip", "Priority {{priority}} - Images at top have more influence", { priority: index + 1 })}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Image */}
        <img
          src={image.url}
          alt={t("referenceImage.alt", "Reference {{index}}", { index: index + 1 })}
          className="w-full h-full object-cover"
          draggable={false}
        />

        {/* Remove button */}
        <button
          onClick={() => onRemove(image.id)}
          className="absolute top-0.5 end-0.5 w-5 h-5 rounded-full bg-background/80 hover:bg-destructive hover:text-destructive-foreground text-xs flex items-center justify-center transition-colors z-20"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Type selector with help tooltip */}
      <div className="flex items-center gap-0.5">
        <Select
          value={image.type}
          onValueChange={(value: ReferenceType) => onTypeChange(image.id, value)}
        >
          <SelectTrigger className="h-6 w-[52px] text-[10px] px-1">
            <TypeIcon className="w-3 h-3 me-0.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-background border border-border z-50">
            {referenceTypes.map((type) => (
              <SelectItem key={type.value} value={type.value} className="text-xs">
                <div className="flex items-center gap-1">
                  <type.icon className="w-3 h-3" />
                  <span>{type.label}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        
        {/* Help icon with detailed tooltip */}
        <ReferenceTypeTooltip type={image.type}>
          <button className="w-4 h-4 rounded-full hover:bg-muted flex items-center justify-center transition-colors">
            <HelpCircle className="w-3 h-3 text-muted-foreground" />
          </button>
        </ReferenceTypeTooltip>
      </div>
    </div>
  );
}
