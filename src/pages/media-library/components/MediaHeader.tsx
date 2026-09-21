import { Upload, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MediaHeaderProps {
  onUpload: () => void;
  onCreateFolder: () => void;
}

export function MediaHeader({ onUpload, onCreateFolder }: MediaHeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold">Media Library</h1>
        <p className="text-muted-foreground mt-1">
          Browse, upload, and manage your media files
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={onUpload}>
          <Upload className="w-4 h-4 me-2" />
          Upload
        </Button>
        <Button variant="outline" onClick={onCreateFolder}>
          <FolderPlus className="w-4 h-4 me-2" />
          New Folder
        </Button>
      </div>
    </div>
  );
}
