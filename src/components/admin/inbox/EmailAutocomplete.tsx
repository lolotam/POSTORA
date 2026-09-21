import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { X, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmailContact {
  id: string;
  email: string;
  name: string | null;
  use_count: number;
}

interface EmailAutocompleteProps {
  value: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function EmailAutocomplete({
  value,
  onChange,
  placeholder = "Enter email...",
  className,
  id,
}: EmailAutocompleteProps) {
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectingSuggestionRef = useRef(false);
  const queryClient = useQueryClient();

  // Fetch contacts for autocomplete
  const { data: contacts = [] } = useQuery({
    queryKey: ["email-contacts", inputValue],
    queryFn: async () => {
      if (!inputValue.trim()) return [];
      
      const { data, error } = await supabase
        .from("email_contacts")
        .select("*")
        .or(`email.ilike.%${inputValue}%,name.ilike.%${inputValue}%`)
        .order("use_count", { ascending: false })
        .limit(10);

      if (error) throw error;
      return (data || []) as EmailContact[];
    },
    enabled: inputValue.length >= 1,
  });

  // Save/update contact on use
  const saveContactMutation = useMutation({
    mutationFn: async (email: string) => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return;

      // Try to update existing contact first
      const { data: existing } = await supabase
        .from("email_contacts")
        .select("id, use_count")
        .eq("email", email.toLowerCase())
        .single();

      if (existing) {
        await supabase
          .from("email_contacts")
          .update({
            use_count: (existing.use_count || 0) + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("email_contacts").insert({
          email: email.toLowerCase(),
          admin_id: session.session.user.id,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-contacts"] });
    },
  });

  const filteredSuggestions = contacts.filter(
    (contact) => !value.includes(contact.email.toLowerCase())
  );

  const addEmail = useCallback(
    (email: string) => {
      const normalizedEmail = email.toLowerCase().trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      if (emailRegex.test(normalizedEmail) && !value.includes(normalizedEmail)) {
        onChange([...value, normalizedEmail]);
        saveContactMutation.mutate(normalizedEmail);
        setInputValue("");
        setShowSuggestions(false);
        setSelectedIndex(0);
      }
    },
    [value, onChange, saveContactMutation]
  );

  const removeEmail = useCallback(
    (email: string) => {
      onChange(value.filter((e) => e !== email));
    },
    [value, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      e.preventDefault();
      if (filteredSuggestions.length > 0 && showSuggestions) {
        addEmail(filteredSuggestions[selectedIndex].email);
      } else if (inputValue.trim()) {
        addEmail(inputValue);
      }
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeEmail(value[value.length - 1]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        Math.min(prev + 1, filteredSuggestions.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap gap-1 items-center border rounded-md px-2 py-1 min-h-[40px] bg-background",
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((email) => (
          <Badge key={email} variant="secondary" className="flex items-center gap-1">
            <span className="max-w-[150px] truncate">{email}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeEmail(email);
              }}
              className="hover:bg-muted rounded-full p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <Input
          ref={inputRef}
          id={id}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
            setSelectedIndex(0);
          }}
          onFocus={() => inputValue && setShowSuggestions(true)}
          onBlur={() => {
            // Auto-add email on blur so users don't have to press Enter
            setTimeout(() => {
              if (selectingSuggestionRef.current) {
                selectingSuggestionRef.current = false;
                return;
              }
              if (inputValue.trim()) {
                addEmail(inputValue);
              } else {
                setShowSuggestions(false);
              }
            }, 0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : "Add more..."}
          className="flex-1 min-w-[120px] border-0 p-0 h-7 focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-[200px] overflow-auto">
          {filteredSuggestions.map((contact, index) => (
            <button
              key={contact.id}
              type="button"
              className={cn(
                "w-full px-3 py-2 text-start flex items-center gap-2 hover:bg-accent",
                index === selectedIndex && "bg-accent"
              )}
              onMouseDown={() => {
                selectingSuggestionRef.current = true;
              }}
              onClick={() => addEmail(contact.email)}
            >
              <User className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                {contact.name ? (
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate">{contact.name}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {contact.email}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm truncate">{contact.email}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
