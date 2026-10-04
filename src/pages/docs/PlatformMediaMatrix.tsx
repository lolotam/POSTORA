import { useState } from "react";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { platformMediaSupport, platformDisplayNames } from "@/lib/platformMediaSupport";
import { Check, X, Minus, Info, Image, Video, FileImage, Layers, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const allPlatforms: Platform[] = [
  "instagram", "facebook", "twitter", "linkedin", "bluesky",
  "tiktok", "youtube", "threads", "pinterest", "reddit"
];

type MediaCategory = "photos" | "videos" | "gifs" | "mixed";

interface CategoryConfig {
  id: MediaCategory;
  label: string;
  icon: typeof Image;
  description: string;
}

const categories: CategoryConfig[] = [
  { id: "photos", label: "Photos", icon: Image, description: "Single and multiple photo support" },
  { id: "videos", label: "Videos", icon: Video, description: "Single and multiple video support" },
  { id: "gifs", label: "GIFs", icon: FileImage, description: "Animated GIF support" },
  { id: "mixed", label: "Mixed Media", icon: Shuffle, description: "Combining different media types" },
];

function SupportIndicator({ 
  supported, 
  note,
  limit,
}: { 
  supported: boolean | "partial"; 
  note?: string;
  limit?: number | string;
}) {
  if (supported === "partial") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <div className="flex items-center gap-1">
              <Minus className="w-4 h-4 text-amber-500" />
              {limit && <span className="text-xs text-amber-500">{limit}</span>}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs max-w-[200px]">{note}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (supported) {
    return (
      <div className="flex items-center gap-1">
        <Check className="w-4 h-4 text-green-500" />
        {limit && <span className="text-xs text-muted-foreground">{limit}</span>}
      </div>
    );
  }

  return <X className="w-4 h-4 text-destructive/60" />;
}

function PlatformRow({ platform }: { platform: Platform }) {
  const support = platformMediaSupport[platform];
  
  return (
    <tr className="border-b border-border/50 hover:bg-muted/30 transition-colors">
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <PlatformIcon platform={platform} size="sm" />
          <span className="font-medium text-sm">{platformDisplayNames[platform]}</span>
        </div>
      </td>
      
      {/* Text Only */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator supported={support.textOnly} />
      </td>
      
      {/* Single Photo */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator 
          supported={support.singlePhoto} 
          note={support.minPhotosForCarousel ? `Requires ${support.minPhotosForCarousel}+ photos` : undefined}
        />
      </td>
      
      {/* Multiple Photos */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator 
          supported={support.maxPhotos > 1} 
          limit={support.maxPhotos > 1 ? `${support.maxPhotos}` : undefined}
          note={support.minPhotosForCarousel ? `Requires ${support.minPhotosForCarousel}-${support.maxPhotos} photos` : undefined}
        />
      </td>
      
      {/* Single GIF */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator 
          supported={support.singleGif ? (support.gifNote ? "partial" : true) : false}
          note={support.gifNote}
        />
      </td>
      
      {/* Multiple GIFs */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator supported={support.multipleGifs} />
      </td>
      
      {/* Single Video */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator supported={support.singleVideo} />
      </td>
      
      {/* Multiple Videos */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator 
          supported={support.multipleVideos} 
          limit={support.maxVideos > 1 ? `${support.maxVideos}` : undefined}
        />
      </td>
      
      {/* Mixed Media */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator supported={support.mixedMedia} />
      </td>
      
      {/* Mixed with GIF */}
      <td className="py-3 px-4 text-center">
        <SupportIndicator supported={support.mixedWithGif} />
      </td>
    </tr>
  );
}

export default function PlatformMediaMatrix() {
  const [activeCategory, setActiveCategory] = useState<MediaCategory | "all">("all");

  return (
    <div className="min-h-screen bg-background">
      <DocsHeader breadcrumbs={[
        { label: "Docs", href: "/docs" },
        { label: "Platform Media Matrix" }
      ]} />

      {/* Hero */}
      <div className="border-b border-border bg-primary/5">
        <div className="container mx-auto px-6 py-12">
          <Badge variant="secondary" className="mb-4">
            <Layers className="w-3 h-3 me-1" />
            Media Support Reference
          </Badge>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">
            Platform Media Support Matrix
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            Comprehensive guide to what each social media platform supports for photos, videos, GIFs, carousels, and mixed media posts.
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-12">
        {/* Category Filter */}
        <div className="flex flex-wrap gap-2 mb-8">
          <Button
            variant={activeCategory === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveCategory("all")}
          >
            All Categories
          </Button>
          {categories.map(cat => (
            <Button
              key={cat.id}
              variant={activeCategory === cat.id ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCategory(cat.id)}
              className="gap-2"
            >
              <cat.icon className="w-4 h-4" />
              {cat.label}
            </Button>
          ))}
        </div>

        {/* Legend */}
        <Card className="p-4 mb-8 bg-card/50">
          <div className="flex flex-wrap gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Check className="w-4 h-4 text-green-500" />
              <span>Supported</span>
            </div>
            <div className="flex items-center gap-2">
              <Minus className="w-4 h-4 text-amber-500" />
              <span>Partial / With limitations</span>
            </div>
            <div className="flex items-center gap-2">
              <X className="w-4 h-4 text-destructive/60" />
              <span>Not supported</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Info className="w-4 h-4" />
              <span>Numbers indicate max items allowed</span>
            </div>
          </div>
        </Card>

        {/* Matrix Table */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="py-3 px-4 text-start text-sm font-semibold">Platform</th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">Text Only</th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Image className="w-4 h-4 mb-1" />
                      <span>1 Photo</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Layers className="w-4 h-4 mb-1" />
                      <span>Multi Photo</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <FileImage className="w-4 h-4 mb-1" />
                      <span>1 GIF</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <FileImage className="w-4 h-4 mb-1" />
                      <span>Multi GIF</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Video className="w-4 h-4 mb-1" />
                      <span>1 Video</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Video className="w-4 h-4 mb-1" />
                      <span>Multi Video</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Shuffle className="w-4 h-4 mb-1" />
                      <span>Mixed</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center text-sm font-semibold">
                    <div className="flex flex-col items-center">
                      <Shuffle className="w-4 h-4 mb-1" />
                      <span>+GIF Mix</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {allPlatforms.map(platform => (
                  <PlatformRow key={platform} platform={platform} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Platform Details */}
        <div className="mt-12 space-y-8">
          <h2 className="text-2xl font-bold">Platform-Specific Details</h2>
          
          <div className="grid md:grid-cols-2 gap-6">
            {allPlatforms.map(platform => {
              const support = platformMediaSupport[platform];
              return (
                <Card key={platform} className="p-5 bg-card/50">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                      <PlatformIcon platform={platform} size="md" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{platformDisplayNames[platform]}</h3>
                      <p className="text-xs text-muted-foreground">
                        {support.requiresMedia ? "Requires media" : "Text posts supported"}
                      </p>
                    </div>
                  </div>
                  
                  <div className="space-y-2 text-sm">
                    {support.maxPhotos > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Max photos:</span>
                        <span className="font-medium">
                          {support.minPhotosForCarousel 
                            ? `${support.minPhotosForCarousel}-${support.maxPhotos}`
                            : support.maxPhotos
                          }
                        </span>
                      </div>
                    )}
                    {support.singleVideo && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Max videos:</span>
                        <span className="font-medium">{support.multipleVideos ? support.maxVideos : 1}</span>
                      </div>
                    )}
                    {support.singleGif && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">GIF support:</span>
                        <span className={cn("font-medium", support.gifNote && "text-amber-500")}>
                          {support.gifNote || (support.multipleGifs ? "Multiple" : "Single")}
                        </span>
                      </div>
                    )}
                    {support.mixedMedia && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Mixed media:</span>
                        <Badge variant="secondary" className="text-xs">
                          {support.mixedWithGif ? "Photos + Videos + GIFs" : "Photos + Videos"}
                        </Badge>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Quick Reference */}
        <div className="mt-12">
          <h2 className="text-2xl font-bold mb-6">Quick Reference by Media Type</h2>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card className="p-5">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Image className="w-5 h-5 text-primary" />
                Single Photo
              </h3>
              <div className="flex flex-wrap gap-2">
                {allPlatforms.filter(p => platformMediaSupport[p].singlePhoto).map(p => (
                  <Badge key={p} variant="outline" className="gap-1">
                    <PlatformIcon platform={p} size="xs" />
                    {getPlatformName(p)}
                  </Badge>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <FileImage className="w-5 h-5 text-primary" />
                GIF Support
              </h3>
              <div className="flex flex-wrap gap-2">
                {allPlatforms.filter(p => platformMediaSupport[p].singleGif).map(p => (
                  <Badge key={p} variant="outline" className="gap-1">
                    <PlatformIcon platform={p} size="xs" />
                    {getPlatformName(p)}
                  </Badge>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Shuffle className="w-5 h-5 text-primary" />
                Mixed Media
              </h3>
              <div className="flex flex-wrap gap-2">
                {allPlatforms.filter(p => platformMediaSupport[p].mixedMedia).map(p => (
                  <Badge key={p} variant="outline" className="gap-1">
                    <PlatformIcon platform={p} size="xs" />
                    {getPlatformName(p)}
                  </Badge>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
