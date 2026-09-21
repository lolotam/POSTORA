import { useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  Link,
  Undo,
  Redo,
  Type,
  Palette,
  Highlighter,
  Code2,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export interface RichTextEditorRef {
  insertHtmlAtCursor: (html: string) => void;
  focus: () => void;
}

const FONT_SIZES = [
  { value: "1", label: "Small" },
  { value: "3", label: "Normal" },
  { value: "5", label: "Large" },
  { value: "7", label: "Huge" },
];

const FONT_FAMILIES = [
  { value: "Arial, sans-serif", label: "Sans Serif" },
  { value: "Georgia, serif", label: "Serif" },
  { value: "Courier New, monospace", label: "Monospace" },
  { value: "Comic Sans MS, cursive", label: "Comic Sans" },
  { value: "Impact, sans-serif", label: "Impact" },
];

const COLORS = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc",
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#f43f5e",
];

export const RichTextEditor = forwardRef<RichTextEditorRef, RichTextEditorProps>(({
  value,
  onChange,
  placeholder = "Type your message...",
  minHeight = "200px",
}, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [isCodeMode, setIsCodeMode] = useState(false);
  const [codeValue, setCodeValue] = useState(value);

  // Sync code value when switching modes
  useEffect(() => {
    if (isCodeMode) {
      setCodeValue(value);
    }
  }, [isCodeMode, value]);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    insertHtmlAtCursor: (html: string) => {
      if (isCodeMode) {
        // In code mode, just append
        const newValue = value + html;
        onChange(newValue);
        setCodeValue(newValue);
        return;
      }
      
      if (!editorRef.current) return;
      
      editorRef.current.focus();
      
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        // Check if selection is within the editor
        if (editorRef.current.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          
          // Create a temporary container to parse HTML
          const temp = document.createElement("div");
          temp.innerHTML = html;
          
          const fragment = document.createDocumentFragment();
          while (temp.firstChild) {
            fragment.appendChild(temp.firstChild);
          }
          
          range.insertNode(fragment);
          
          // Move cursor to end of inserted content
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          // If not in editor, append to end
          editorRef.current.innerHTML += html;
        }
      } else {
        // No selection, append to end
        editorRef.current.innerHTML += html;
      }
      
      onChange(editorRef.current.innerHTML);
    },
    focus: () => {
      if (isCodeMode) return;
      editorRef.current?.focus();
    },
  }));

  // Sync external value changes
  useEffect(() => {
    if (!isCodeMode && editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, [value, isCodeMode]);

  const execCommand = useCallback((command: string, val?: string) => {
    if (isCodeMode) return;
    document.execCommand(command, false, val);
    editorRef.current?.focus();
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange, isCodeMode]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle common shortcuts
    if (e.metaKey || e.ctrlKey) {
      switch (e.key.toLowerCase()) {
        case "b":
          e.preventDefault();
          execCommand("bold");
          break;
        case "i":
          e.preventDefault();
          execCommand("italic");
          break;
        case "u":
          e.preventDefault();
          execCommand("underline");
          break;
      }
    }
  };

  const insertLink = () => {
    const url = prompt("Enter URL:");
    if (url) {
      execCommand("createLink", url);
    }
  };

  const handleCodeChange = (newCode: string) => {
    setCodeValue(newCode);
    onChange(newCode);
  };

  const toggleCodeMode = () => {
    if (isCodeMode) {
      // Switching from code to visual - sync the code changes
      if (editorRef.current) {
        editorRef.current.innerHTML = codeValue;
      }
    } else {
      // Switching from visual to code - sync from editor
      setCodeValue(value);
    }
    setIsCodeMode(!isCodeMode);
  };

  const ToolbarButton = ({
    onClick,
    icon: Icon,
    title,
    active = false,
    disabled = false,
  }: {
    onClick: () => void;
    icon: React.ElementType;
    title: string;
    active?: boolean;
    disabled?: boolean;
  }) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8", active && "bg-muted")}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );

  return (
    <div className="border rounded-lg overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 p-2 border-b bg-muted/30">
        {/* Undo/Redo */}
        <ToolbarButton onClick={() => execCommand("undo")} icon={Undo} title="Undo" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("redo")} icon={Redo} title="Redo" disabled={isCodeMode} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Font Family */}
        <Select onValueChange={(val) => execCommand("fontName", val)} disabled={isCodeMode}>
          <SelectTrigger className="h-8 w-[110px] text-xs" disabled={isCodeMode}>
            <SelectValue placeholder="Font" />
          </SelectTrigger>
          <SelectContent>
            {FONT_FAMILIES.map((font) => (
              <SelectItem key={font.value} value={font.value} style={{ fontFamily: font.value }}>
                {font.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Font Size */}
        <Select onValueChange={(val) => execCommand("fontSize", val)} disabled={isCodeMode}>
          <SelectTrigger className="h-8 w-[90px] text-xs" disabled={isCodeMode}>
            <Type className="h-3 w-3 me-1" />
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map((size) => (
              <SelectItem key={size.value} value={size.value}>
                {size.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Text Formatting */}
        <ToolbarButton onClick={() => execCommand("bold")} icon={Bold} title="Bold (Ctrl+B)" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("italic")} icon={Italic} title="Italic (Ctrl+I)" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("underline")} icon={Underline} title="Underline (Ctrl+U)" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("strikethrough")} icon={Strikethrough} title="Strikethrough" disabled={isCodeMode} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Text Color */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Text Color" disabled={isCodeMode}>
              <Palette className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="grid grid-cols-5 gap-1">
              {COLORS.map((color) => (
                <button
                  key={color}
                  className="w-6 h-6 rounded border border-muted-foreground/20 hover:scale-110 transition-transform"
                  style={{ backgroundColor: color }}
                  onClick={() => execCommand("foreColor", color)}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Highlight Color */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Highlight" disabled={isCodeMode}>
              <Highlighter className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="grid grid-cols-5 gap-1">
              {COLORS.map((color) => (
                <button
                  key={color}
                  className="w-6 h-6 rounded border border-muted-foreground/20 hover:scale-110 transition-transform"
                  style={{ backgroundColor: color }}
                  onClick={() => execCommand("hiliteColor", color)}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Alignment */}
        <ToolbarButton onClick={() => execCommand("justifyLeft")} icon={AlignLeft} title="Align Left" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("justifyCenter")} icon={AlignCenter} title="Align Center" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("justifyRight")} icon={AlignRight} title="Align Right" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("justifyFull")} icon={AlignJustify} title="Justify" disabled={isCodeMode} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Lists */}
        <ToolbarButton onClick={() => execCommand("insertUnorderedList")} icon={List} title="Bullet List" disabled={isCodeMode} />
        <ToolbarButton onClick={() => execCommand("insertOrderedList")} icon={ListOrdered} title="Numbered List" disabled={isCodeMode} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Link */}
        <ToolbarButton onClick={insertLink} icon={Link} title="Insert Link" disabled={isCodeMode} />

        {/* Code Mode Toggle */}
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            variant={isCodeMode ? "default" : "ghost"}
            size="sm"
            onClick={toggleCodeMode}
            title={isCodeMode ? "Switch to Visual Editor" : "Edit HTML Code"}
            className="h-8 px-2 text-xs gap-1"
          >
            {isCodeMode ? (
              <>
                <Eye className="h-3.5 w-3.5" />
                Visual
              </>
            ) : (
              <>
                <Code2 className="h-3.5 w-3.5" />
                HTML
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Editor Content */}
      {isCodeMode ? (
        <Textarea
          value={codeValue}
          onChange={(e) => handleCodeChange(e.target.value)}
          placeholder="<p>Enter HTML code here...</p>"
          className="border-0 rounded-none focus-visible:ring-0 font-mono text-sm resize-none"
          style={{ minHeight }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          className={cn(
            "p-4 outline-none overflow-auto prose prose-sm dark:prose-invert max-w-none",
            "focus:ring-0 focus:outline-none",
            "[&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-muted-foreground [&:empty]:before:cursor-text"
          )}
          style={{ minHeight }}
          data-placeholder={placeholder}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          suppressContentEditableWarning
        />
      )}
    </div>
  );
});

RichTextEditor.displayName = "RichTextEditor";
