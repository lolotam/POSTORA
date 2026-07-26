export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          created_at: string
          details: Json | null
          id: string
          ip_address: string | null
          resource_id: string | null
          resource_type: string
          user_agent: string | null
        }
        Insert: {
          action: string
          admin_id: string
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          resource_id?: string | null
          resource_type: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          resource_id?: string | null
          resource_type?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      admin_inbox_messages: {
        Row: {
          admin_id: string | null
          attachments: Json | null
          body: string | null
          created_at: string
          direction: string
          from_email: string
          html_body: string | null
          id: string
          is_read: boolean
          message_type: string
          metadata: Json | null
          reply_to_id: string | null
          resend_id: string | null
          status: string
          subject: string | null
          thread_id: string | null
          to_email: string
          updated_at: string
        }
        Insert: {
          admin_id?: string | null
          attachments?: Json | null
          body?: string | null
          created_at?: string
          direction?: string
          from_email: string
          html_body?: string | null
          id?: string
          is_read?: boolean
          message_type?: string
          metadata?: Json | null
          reply_to_id?: string | null
          resend_id?: string | null
          status?: string
          subject?: string | null
          thread_id?: string | null
          to_email: string
          updated_at?: string
        }
        Update: {
          admin_id?: string | null
          attachments?: Json | null
          body?: string | null
          created_at?: string
          direction?: string
          from_email?: string
          html_body?: string | null
          id?: string
          is_read?: boolean
          message_type?: string
          metadata?: Json | null
          reply_to_id?: string | null
          resend_id?: string | null
          status?: string
          subject?: string | null
          thread_id?: string | null
          to_email?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_inbox_messages_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "admin_inbox_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_notifications: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          message: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          message: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          message?: string
          title?: string
        }
        Relationships: []
      }
      ai_agent_allowed_models: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string
          model_id: string
          provider: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          model_id: string
          provider: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          model_id?: string
          provider?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      ai_agent_configs: {
        Row: {
          admin_phone_numbers: string[]
          business_profile_text: string | null
          created_at: string | null
          daily_message_cap: number
          default_mode: string
          fallback_model_1: string | null
          fallback_model_2: string | null
          handoff_on_low_confidence: boolean | null
          handoff_on_request: boolean | null
          id: string
          is_enabled: boolean | null
          language_mode: string
          max_tool_iterations: number
          model: string
          persona_instructions: string | null
          platform: string
          reply_cooldown_seconds: number
          temperature: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          admin_phone_numbers?: string[]
          business_profile_text?: string | null
          created_at?: string | null
          daily_message_cap?: number
          default_mode?: string
          fallback_model_1?: string | null
          fallback_model_2?: string | null
          handoff_on_low_confidence?: boolean | null
          handoff_on_request?: boolean | null
          id?: string
          is_enabled?: boolean | null
          language_mode?: string
          max_tool_iterations?: number
          model?: string
          persona_instructions?: string | null
          platform: string
          reply_cooldown_seconds?: number
          temperature?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          admin_phone_numbers?: string[]
          business_profile_text?: string | null
          created_at?: string | null
          daily_message_cap?: number
          default_mode?: string
          fallback_model_1?: string | null
          fallback_model_2?: string | null
          handoff_on_low_confidence?: boolean | null
          handoff_on_request?: boolean | null
          id?: string
          is_enabled?: boolean | null
          language_mode?: string
          max_tool_iterations?: number
          model?: string
          persona_instructions?: string | null
          platform?: string
          reply_cooldown_seconds?: number
          temperature?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_agent_logs: {
        Row: {
          completion_tokens: number | null
          conversation_id: string | null
          created_at: string | null
          error: string | null
          id: string
          inbound_text: string | null
          latency_ms: number | null
          platform: string | null
          prompt_tokens: number | null
          reply_text: string | null
          retrieved_chunk_ids: string[] | null
          status: string | null
          tool_calls: Json | null
          user_id: string
        }
        Insert: {
          completion_tokens?: number | null
          conversation_id?: string | null
          created_at?: string | null
          error?: string | null
          id?: string
          inbound_text?: string | null
          latency_ms?: number | null
          platform?: string | null
          prompt_tokens?: number | null
          reply_text?: string | null
          retrieved_chunk_ids?: string[] | null
          status?: string | null
          tool_calls?: Json | null
          user_id: string
        }
        Update: {
          completion_tokens?: number | null
          conversation_id?: string | null
          created_at?: string | null
          error?: string | null
          id?: string
          inbound_text?: string | null
          latency_ms?: number | null
          platform?: string | null
          prompt_tokens?: number | null
          reply_text?: string | null
          retrieved_chunk_ids?: string[] | null
          status?: string | null
          tool_calls?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      ai_agent_tools: {
        Row: {
          admin_only: boolean | null
          created_at: string | null
          description: string
          id: string
          is_enabled: boolean | null
          name: string
          secret: string | null
          tool_type: string
          updated_at: string | null
          url: string | null
          user_id: string
        }
        Insert: {
          admin_only?: boolean | null
          created_at?: string | null
          description: string
          id?: string
          is_enabled?: boolean | null
          name: string
          secret?: string | null
          tool_type?: string
          updated_at?: string | null
          url?: string | null
          user_id: string
        }
        Update: {
          admin_only?: boolean | null
          created_at?: string | null
          description?: string
          id?: string
          is_enabled?: boolean | null
          name?: string
          secret?: string | null
          tool_type?: string
          updated_at?: string | null
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_conversation_modes: {
        Row: {
          conversation_id: string
          created_at: string | null
          id: string
          mode: string
          platform: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string | null
          id?: string
          mode: string
          platform: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string | null
          id?: string
          mode?: string
          platform?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_knowledge_chunks: {
        Row: {
          content: string
          created_at: string | null
          embedding: string | null
          embedding_bge_m3: string | null
          id: string
          metadata: Json | null
          source_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          embedding?: string | null
          embedding_bge_m3?: string | null
          id?: string
          metadata?: Json | null
          source_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          embedding?: string | null
          embedding_bge_m3?: string | null
          id?: string
          metadata?: Json | null
          source_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_chunks_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_entities: {
        Row: {
          created_at: string
          description: string
          id: string
          metadata: Json
          name: string
          normalized_name: string | null
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          metadata?: Json
          name: string
          normalized_name?: string | null
          type: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          metadata?: Json
          name?: string
          normalized_name?: string | null
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_knowledge_graph_exports: {
        Row: {
          generated_at: string
          html_url: string | null
          id: string
          user_id: string
          vault_url: string | null
        }
        Insert: {
          generated_at?: string
          html_url?: string | null
          id?: string
          user_id: string
          vault_url?: string | null
        }
        Update: {
          generated_at?: string
          html_url?: string | null
          id?: string
          user_id?: string
          vault_url?: string | null
        }
        Relationships: []
      }
      ai_knowledge_relations: {
        Row: {
          created_at: string
          id: string
          relation: string
          source_chunk_id: string
          source_entity_id: string
          target_entity_id: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          id?: string
          relation: string
          source_chunk_id: string
          source_entity_id: string
          target_entity_id: string
          user_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          id?: string
          relation?: string
          source_chunk_id?: string
          source_entity_id?: string
          target_entity_id?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_relations_source_chunk_id_fkey"
            columns: ["source_chunk_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_chunks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_relations_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_relations_target_entity_id_fkey"
            columns: ["target_entity_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_sources: {
        Row: {
          chunk_count: number | null
          created_at: string | null
          error: string | null
          file_name: string | null
          file_path: string | null
          id: string
          source_type: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          chunk_count?: number | null
          created_at?: string | null
          error?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          source_type?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          chunk_count?: number | null
          created_at?: string | null
          error?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          source_type?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_model_preferences: {
        Row: {
          created_at: string
          feature: string
          id: string
          model_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          feature?: string
          id?: string
          model_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          feature?: string
          id?: string
          model_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_model_preferences_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "ai_models"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_models: {
        Row: {
          capabilities: string[]
          context_limit: number | null
          cost_per_1m_input_tokens: number | null
          cost_per_1m_output_tokens: number | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          model_id: string
          name: string
          provider_id: string
          updated_at: string
        }
        Insert: {
          capabilities?: string[]
          context_limit?: number | null
          cost_per_1m_input_tokens?: number | null
          cost_per_1m_output_tokens?: number | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          model_id: string
          name: string
          provider_id: string
          updated_at?: string
        }
        Update: {
          capabilities?: string[]
          context_limit?: number | null
          cost_per_1m_input_tokens?: number | null
          cost_per_1m_output_tokens?: number | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          model_id?: string
          name?: string
          provider_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_models_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_providers: {
        Row: {
          api_endpoint: string
          api_key_env_var: string
          api_type: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          provider_code: string
          supports_streaming: boolean
          updated_at: string
        }
        Insert: {
          api_endpoint: string
          api_key_env_var: string
          api_type?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          provider_code: string
          supports_streaming?: boolean
          updated_at?: string
        }
        Update: {
          api_endpoint?: string
          api_key_env_var?: string
          api_type?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          provider_code?: string
          supports_streaming?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      ai_thread_messages: {
        Row: {
          content: string | null
          created_at: string | null
          id: string
          role: string
          thread_id: string
          tool_calls: Json | null
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          id?: string
          role: string
          thread_id: string
          tool_calls?: Json | null
          user_id: string
        }
        Update: {
          content?: string | null
          created_at?: string | null
          id?: string
          role?: string
          thread_id?: string
          tool_calls?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_thread_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "ai_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_threads: {
        Row: {
          conversation_id: string
          created_at: string | null
          id: string
          platform: string
          title: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string | null
          id?: string
          platform: string
          title?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string | null
          id?: string
          platform?: string
          title?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      api_logs: {
        Row: {
          created_at: string | null
          endpoint: string
          id: string
          ip_address: unknown
          method: string
          request_data: Json | null
          response_data: Json | null
          status_code: number | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          endpoint: string
          id?: string
          ip_address?: unknown
          method: string
          request_data?: Json | null
          response_data?: Json | null
          status_code?: number | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          endpoint?: string
          id?: string
          ip_address?: unknown
          method?: string
          request_data?: Json | null
          response_data?: Json | null
          status_code?: number | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      app_credentials: {
        Row: {
          kind: string
          platform: string
          secret_name: string
          secret_value: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          kind: string
          platform: string
          secret_name: string
          secret_value: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          kind?: string
          platform?: string
          secret_name?: string
          secret_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          key: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: Json
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      backup_codes: {
        Row: {
          code_hash: string
          created_at: string | null
          id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string | null
          id?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string | null
          id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bi_post_content: {
        Row: {
          captions: string[] | null
          created_at: string | null
          generation_language: string | null
          generation_platform: string | null
          generation_tone: string | null
          id: string
          image_prompts: string[] | null
          platform: string
          post_data: Json
          post_id: string
          transcript: string | null
          transcript_duration: number | null
          transcript_language: string | null
          updated_at: string | null
          user_id: string
          username: string | null
          video_prompts: string[] | null
        }
        Insert: {
          captions?: string[] | null
          created_at?: string | null
          generation_language?: string | null
          generation_platform?: string | null
          generation_tone?: string | null
          id?: string
          image_prompts?: string[] | null
          platform: string
          post_data: Json
          post_id: string
          transcript?: string | null
          transcript_duration?: number | null
          transcript_language?: string | null
          updated_at?: string | null
          user_id: string
          username?: string | null
          video_prompts?: string[] | null
        }
        Update: {
          captions?: string[] | null
          created_at?: string | null
          generation_language?: string | null
          generation_platform?: string | null
          generation_tone?: string | null
          id?: string
          image_prompts?: string[] | null
          platform?: string
          post_data?: Json
          post_id?: string
          transcript?: string | null
          transcript_duration?: number | null
          transcript_language?: string | null
          updated_at?: string | null
          user_id?: string
          username?: string | null
          video_prompts?: string[] | null
        }
        Relationships: []
      }
      blog_posts: {
        Row: {
          author_id: string | null
          content: string
          cover_image_url: string | null
          created_at: string
          excerpt: string | null
          id: string
          scheduled_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          content: string
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          scheduled_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          content?: string
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          scheduled_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      brand_scrape_cache: {
        Row: {
          cache_key: string
          created_at: string | null
          expires_at: string
          id: string
          platform: string
          response_data: Json
          username: string
        }
        Insert: {
          cache_key: string
          created_at?: string | null
          expires_at: string
          id?: string
          platform: string
          response_data: Json
          username: string
        }
        Update: {
          cache_key?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          platform?: string
          response_data?: Json
          username?: string
        }
        Relationships: []
      }
      brand_scrape_sessions: {
        Row: {
          api_endpoint: string | null
          created_at: string | null
          id: string
          platform: string
          posts_data: Json | null
          profile_data: Json | null
          scraped_at: string | null
          strategy_used: string | null
          total_posts_fetched: number | null
          user_id: string
          username: string
        }
        Insert: {
          api_endpoint?: string | null
          created_at?: string | null
          id?: string
          platform?: string
          posts_data?: Json | null
          profile_data?: Json | null
          scraped_at?: string | null
          strategy_used?: string | null
          total_posts_fetched?: number | null
          user_id: string
          username: string
        }
        Update: {
          api_endpoint?: string | null
          created_at?: string | null
          id?: string
          platform?: string
          posts_data?: Json | null
          profile_data?: Json | null
          scraped_at?: string | null
          strategy_used?: string | null
          total_posts_fetched?: number | null
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      brand_search_history: {
        Row: {
          created_at: string
          id: string
          last_used_at: string
          platform: string
          query: string
          scope: string
          use_count: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string
          platform: string
          query: string
          scope: string
          use_count?: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string
          platform?: string
          query?: string
          scope?: string
          use_count?: number
          user_id?: string
        }
        Relationships: []
      }
      caption_history: {
        Row: {
          caption: string
          created_at: string
          id: string
          language: string | null
          platform: string | null
          prompt: string | null
          tone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          caption: string
          created_at?: string
          id?: string
          language?: string | null
          platform?: string | null
          prompt?: string | null
          tone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          caption?: string
          created_at?: string
          id?: string
          language?: string | null
          platform?: string | null
          prompt?: string | null
          tone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      comment_inbox_cache: {
        Row: {
          author_id: string | null
          author_name: string | null
          comment_id: string
          comment_time: string | null
          created_at: string | null
          id: string
          is_hidden: boolean | null
          is_reply: boolean | null
          message: string | null
          parent_comment_id: string | null
          platform: string
          post_id: string
          sentiment: string | null
          social_account_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          author_id?: string | null
          author_name?: string | null
          comment_id: string
          comment_time?: string | null
          created_at?: string | null
          id?: string
          is_hidden?: boolean | null
          is_reply?: boolean | null
          message?: string | null
          parent_comment_id?: string | null
          platform: string
          post_id: string
          sentiment?: string | null
          social_account_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          author_id?: string | null
          author_name?: string | null
          comment_id?: string
          comment_time?: string | null
          created_at?: string | null
          id?: string
          is_hidden?: boolean | null
          is_reply?: boolean | null
          message?: string | null
          parent_comment_id?: string | null
          platform?: string
          post_id?: string
          sentiment?: string | null
          social_account_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      coupon_redemptions: {
        Row: {
          coupon_id: string
          discount_applied: number
          id: string
          metadata: Json | null
          original_amount: number | null
          redeemed_at: string
          subscription_id: string | null
          user_id: string
        }
        Insert: {
          coupon_id: string
          discount_applied: number
          id?: string
          metadata?: Json | null
          original_amount?: number | null
          redeemed_at?: string
          subscription_id?: string | null
          user_id: string
        }
        Update: {
          coupon_id?: string
          discount_applied?: number
          id?: string
          metadata?: Json | null
          original_amount?: number | null
          redeemed_at?: string
          subscription_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "user_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          applicable_plans: string[] | null
          code: string
          created_at: string
          created_by: string | null
          description: string | null
          discount_amount: number
          discount_type: string
          expires_at: string | null
          id: string
          is_active: boolean
          max_per_user: number | null
          max_redemptions: number | null
          metadata: Json | null
          min_plan_value: number | null
          total_redemptions: number
          trial_days: number | null
          updated_at: string
          valid_from: string
        }
        Insert: {
          applicable_plans?: string[] | null
          code: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_amount: number
          discount_type: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_per_user?: number | null
          max_redemptions?: number | null
          metadata?: Json | null
          min_plan_value?: number | null
          total_redemptions?: number
          trial_days?: number | null
          updated_at?: string
          valid_from?: string
        }
        Update: {
          applicable_plans?: string[] | null
          code?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_amount?: number
          discount_type?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_per_user?: number | null
          max_redemptions?: number | null
          metadata?: Json | null
          min_plan_value?: number | null
          total_redemptions?: number
          trial_days?: number | null
          updated_at?: string
          valid_from?: string
        }
        Relationships: []
      }
      credit_transactions: {
        Row: {
          amount: number
          created_at: string
          description: string | null
          id: string
          stripe_session_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          description?: string | null
          id?: string
          stripe_session_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          stripe_session_id?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      deployment_logs: {
        Row: {
          commit_hash: string | null
          commit_message: string | null
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          environment: string
          error_message: string | null
          id: string
          metadata: Json | null
          started_at: string
          status: string
          triggered_by: string | null
          version: string | null
        }
        Insert: {
          commit_hash?: string | null
          commit_message?: string | null
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          environment?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          version?: string | null
        }
        Update: {
          commit_hash?: string | null
          commit_message?: string | null
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          environment?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_logs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_logs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      edge_function_status: {
        Row: {
          avg_execution_time_ms: number | null
          checked_at: string
          cpu_percent: number | null
          deployed_at: string | null
          error_rate: number | null
          function_name: string
          id: string
          invocations_last_hour: number | null
          last_error: string | null
          last_error_at: string | null
          last_invocation: string | null
          memory_mb: number | null
          metadata: Json | null
          status: string | null
          version: string | null
        }
        Insert: {
          avg_execution_time_ms?: number | null
          checked_at?: string
          cpu_percent?: number | null
          deployed_at?: string | null
          error_rate?: number | null
          function_name: string
          id?: string
          invocations_last_hour?: number | null
          last_error?: string | null
          last_error_at?: string | null
          last_invocation?: string | null
          memory_mb?: number | null
          metadata?: Json | null
          status?: string | null
          version?: string | null
        }
        Update: {
          avg_execution_time_ms?: number | null
          checked_at?: string
          cpu_percent?: number | null
          deployed_at?: string | null
          error_rate?: number | null
          function_name?: string
          id?: string
          invocations_last_hour?: number | null
          last_error?: string | null
          last_error_at?: string | null
          last_invocation?: string | null
          memory_mb?: number | null
          metadata?: Json | null
          status?: string | null
          version?: string | null
        }
        Relationships: []
      }
      email_contacts: {
        Row: {
          admin_id: string | null
          created_at: string
          email: string
          id: string
          last_used_at: string | null
          name: string | null
          use_count: number | null
        }
        Insert: {
          admin_id?: string | null
          created_at?: string
          email: string
          id?: string
          last_used_at?: string | null
          name?: string | null
          use_count?: number | null
        }
        Update: {
          admin_id?: string | null
          created_at?: string
          email?: string
          id?: string
          last_used_at?: string | null
          name?: string | null
          use_count?: number | null
        }
        Relationships: []
      }
      email_drafts: {
        Row: {
          admin_id: string
          attachments: Json | null
          bcc_emails: string[] | null
          body: string | null
          cc_emails: string[] | null
          created_at: string
          from_email: string
          html_body: string | null
          id: string
          reply_to_message_id: string | null
          signature_id: string | null
          subject: string | null
          to_emails: string[] | null
          updated_at: string
        }
        Insert: {
          admin_id: string
          attachments?: Json | null
          bcc_emails?: string[] | null
          body?: string | null
          cc_emails?: string[] | null
          created_at?: string
          from_email: string
          html_body?: string | null
          id?: string
          reply_to_message_id?: string | null
          signature_id?: string | null
          subject?: string | null
          to_emails?: string[] | null
          updated_at?: string
        }
        Update: {
          admin_id?: string
          attachments?: Json | null
          bcc_emails?: string[] | null
          body?: string | null
          cc_emails?: string[] | null
          created_at?: string
          from_email?: string
          html_body?: string | null
          id?: string
          reply_to_message_id?: string | null
          signature_id?: string | null
          subject?: string | null
          to_emails?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_drafts_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "admin_inbox_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_drafts_signature_id_fkey"
            columns: ["signature_id"]
            isOneToOne: false
            referencedRelation: "email_signatures"
            referencedColumns: ["id"]
          },
        ]
      }
      email_log: {
        Row: {
          clicked_at: string | null
          created_at: string
          error_message: string | null
          id: string
          metadata: Json | null
          opened_at: string | null
          provider_id: string | null
          recipient_email: string
          recipient_id: string | null
          sent_at: string | null
          status: string | null
          subject: string
          template_id: string | null
        }
        Insert: {
          clicked_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          opened_at?: string | null
          provider_id?: string | null
          recipient_email: string
          recipient_id?: string | null
          sent_at?: string | null
          status?: string | null
          subject: string
          template_id?: string | null
        }
        Update: {
          clicked_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          opened_at?: string | null
          provider_id?: string | null
          recipient_email?: string
          recipient_id?: string | null
          sent_at?: string | null
          status?: string | null
          subject?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_log_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      email_signatures: {
        Row: {
          admin_id: string
          content: string
          created_at: string
          id: string
          is_default: boolean | null
          name: string
          updated_at: string
        }
        Insert: {
          admin_id: string
          content: string
          created_at?: string
          id?: string
          is_default?: boolean | null
          name: string
          updated_at?: string
        }
        Update: {
          admin_id?: string
          content?: string
          created_at?: string
          id?: string
          is_default?: boolean | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_templates: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean | null
          name: string
          slug: string
          subject: string
          updated_at: string
          variables: Json | null
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          slug: string
          subject: string
          updated_at?: string
          variables?: Json | null
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          slug?: string
          subject?: string
          updated_at?: string
          variables?: Json | null
        }
        Relationships: []
      }
      feature_flag_audit_log: {
        Row: {
          change_type: string
          changed_by: string | null
          created_at: string
          feature_key: string
          id: string
          new_value: boolean
          notes: string | null
          old_value: boolean | null
        }
        Insert: {
          change_type?: string
          changed_by?: string | null
          created_at?: string
          feature_key: string
          id?: string
          new_value: boolean
          notes?: string | null
          old_value?: boolean | null
        }
        Update: {
          change_type?: string
          changed_by?: string | null
          created_at?: string
          feature_key?: string
          id?: string
          new_value?: boolean
          notes?: string | null
          old_value?: boolean | null
        }
        Relationships: []
      }
      feature_flag_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          executed_at: string | null
          feature_key: string
          id: string
          scheduled_at: string
          scheduled_value: boolean
          status: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          executed_at?: string | null
          feature_key: string
          id?: string
          scheduled_at: string
          scheduled_value: boolean
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          executed_at?: string | null
          feature_key?: string
          id?: string
          scheduled_at?: string
          scheduled_value?: boolean
          status?: string
        }
        Relationships: []
      }
      generated_content_collections: {
        Row: {
          created_at: string | null
          id: string
          image_prompts: Json | null
          language: string | null
          post_prompts: Json | null
          source_caption: string | null
          source_platform: string | null
          source_post_url: string | null
          source_username: string | null
          target_platform: string | null
          tone: string | null
          transcript: string | null
          user_id: string
          video_prompts: Json | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          image_prompts?: Json | null
          language?: string | null
          post_prompts?: Json | null
          source_caption?: string | null
          source_platform?: string | null
          source_post_url?: string | null
          source_username?: string | null
          target_platform?: string | null
          tone?: string | null
          transcript?: string | null
          user_id: string
          video_prompts?: Json | null
        }
        Update: {
          created_at?: string | null
          id?: string
          image_prompts?: Json | null
          language?: string | null
          post_prompts?: Json | null
          source_caption?: string | null
          source_platform?: string | null
          source_post_url?: string | null
          source_username?: string | null
          target_platform?: string | null
          tone?: string | null
          transcript?: string | null
          user_id?: string
          video_prompts?: Json | null
        }
        Relationships: []
      }
      image_reference_presets: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          reference_images: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          reference_images?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          reference_images?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      launch_checklist: {
        Row: {
          action_url: string | null
          category: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          dependency_id: string | null
          description: string | null
          id: string
          is_completed: boolean | null
          is_required: boolean | null
          resources: Json | null
          sort_order: number | null
          title: string
          updated_at: string
        }
        Insert: {
          action_url?: string | null
          category: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          dependency_id?: string | null
          description?: string | null
          id?: string
          is_completed?: boolean | null
          is_required?: boolean | null
          resources?: Json | null
          sort_order?: number | null
          title: string
          updated_at?: string
        }
        Update: {
          action_url?: string | null
          category?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          dependency_id?: string | null
          description?: string | null
          id?: string
          is_completed?: boolean | null
          is_required?: boolean | null
          resources?: Json | null
          sort_order?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "launch_checklist_dependency_id_fkey"
            columns: ["dependency_id"]
            isOneToOne: false
            referencedRelation: "launch_checklist"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_forms: {
        Row: {
          created_at: string | null
          form_id: string
          form_name: string | null
          form_status: string | null
          id: string
          last_synced_at: string | null
          page_id: string
          social_account_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          form_id: string
          form_name?: string | null
          form_status?: string | null
          id?: string
          last_synced_at?: string | null
          page_id: string
          social_account_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          form_id?: string
          form_name?: string | null
          form_status?: string | null
          id?: string
          last_synced_at?: string | null
          page_id?: string
          social_account_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          form_id: string | null
          id: string
          lead_data: Json
          meta_lead_id: string | null
          notes: string | null
          status: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          form_id?: string | null
          id?: string
          lead_data?: Json
          meta_lead_id?: string | null
          notes?: string | null
          status?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          form_id?: string | null
          id?: string
          lead_data?: Json
          meta_lead_id?: string | null
          notes?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "lead_forms"
            referencedColumns: ["id"]
          },
        ]
      }
      log_analyses: {
        Row: {
          created_at: string | null
          explanation: string
          id: string
          log_id: string
          lovable_prompt: string
          root_cause: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          explanation: string
          id?: string
          log_id: string
          lovable_prompt: string
          root_cause: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          explanation?: string
          id?: string
          log_id?: string
          lovable_prompt?: string
          root_cause?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "log_analyses_log_id_fkey"
            columns: ["log_id"]
            isOneToOne: true
            referencedRelation: "system_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_oauth_authorizations: {
        Row: {
          client_id: string
          code: string | null
          code_challenge: string
          code_challenge_method: string
          code_used_at: string | null
          consented_at: string | null
          created_at: string
          expires_at: string
          id: string
          redirect_uri: string
          scope: string | null
          state: string | null
          user_id: string | null
        }
        Insert: {
          client_id: string
          code?: string | null
          code_challenge: string
          code_challenge_method?: string
          code_used_at?: string | null
          consented_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          redirect_uri: string
          scope?: string | null
          state?: string | null
          user_id?: string | null
        }
        Update: {
          client_id?: string
          code?: string | null
          code_challenge?: string
          code_challenge_method?: string
          code_used_at?: string | null
          consented_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          redirect_uri?: string
          scope?: string | null
          state?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mcp_oauth_authorizations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mcp_oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      mcp_oauth_clients: {
        Row: {
          client_id: string
          client_name: string
          client_secret_hash: string | null
          client_uri: string | null
          created_at: string
          grant_types: string[]
          logo_uri: string | null
          redirect_uris: string[]
          response_types: string[]
          scope: string | null
          software_id: string | null
          software_version: string | null
          token_endpoint_auth_method: string
          updated_at: string
        }
        Insert: {
          client_id: string
          client_name: string
          client_secret_hash?: string | null
          client_uri?: string | null
          created_at?: string
          grant_types?: string[]
          logo_uri?: string | null
          redirect_uris?: string[]
          response_types?: string[]
          scope?: string | null
          software_id?: string | null
          software_version?: string | null
          token_endpoint_auth_method?: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          client_name?: string
          client_secret_hash?: string | null
          client_uri?: string | null
          created_at?: string
          grant_types?: string[]
          logo_uri?: string | null
          redirect_uris?: string[]
          response_types?: string[]
          scope?: string | null
          software_id?: string | null
          software_version?: string | null
          token_endpoint_auth_method?: string
          updated_at?: string
        }
        Relationships: []
      }
      mcp_oauth_tokens: {
        Row: {
          client_id: string
          created_at: string
          expires_at: string
          id: string
          last_used_at: string | null
          last_user_agent: string | null
          refresh_expires_at: string | null
          refresh_token_hash: string | null
          revoked_at: string | null
          scopes: string[]
          token_hash: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          expires_at: string
          id?: string
          last_used_at?: string | null
          last_user_agent?: string | null
          refresh_expires_at?: string | null
          refresh_token_hash?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_hash: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          last_used_at?: string | null
          last_user_agent?: string | null
          refresh_expires_at?: string | null
          refresh_token_hash?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_oauth_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mcp_oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      media_files: {
        Row: {
          cloudinary_public_id: string | null
          created_at: string | null
          file_path: string
          file_size: number | null
          file_type: string
          folder_path: string | null
          id: string
          metadata: Json | null
          mime_type: string | null
          platforms: string[] | null
          social_account_ids: string[] | null
          storage_bucket: string | null
          upload_date: string | null
          user_id: string
        }
        Insert: {
          cloudinary_public_id?: string | null
          created_at?: string | null
          file_path: string
          file_size?: number | null
          file_type: string
          folder_path?: string | null
          id?: string
          metadata?: Json | null
          mime_type?: string | null
          platforms?: string[] | null
          social_account_ids?: string[] | null
          storage_bucket?: string | null
          upload_date?: string | null
          user_id: string
        }
        Update: {
          cloudinary_public_id?: string | null
          created_at?: string | null
          file_path?: string
          file_size?: number | null
          file_type?: string
          folder_path?: string | null
          id?: string
          metadata?: Json | null
          mime_type?: string | null
          platforms?: string[] | null
          social_account_ids?: string[] | null
          storage_bucket?: string | null
          upload_date?: string | null
          user_id?: string
        }
        Relationships: []
      }
      media_folders: {
        Row: {
          created_at: string
          full_path: string
          id: string
          name: string
          parent_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          full_path: string
          id?: string
          name: string
          parent_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          full_path?: string
          id?: string
          name?: string
          parent_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      media_operations_history: {
        Row: {
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          file_name: string | null
          id: string
          media_file_id: string | null
          operation_details: Json | null
          operation_type: string
          result_url: string | null
          source_url: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          file_name?: string | null
          id?: string
          media_file_id?: string | null
          operation_details?: Json | null
          operation_type: string
          result_url?: string | null
          source_url?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          file_name?: string | null
          id?: string
          media_file_id?: string | null
          operation_details?: Json | null
          operation_type?: string
          result_url?: string | null
          source_url?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_operations_history_media_file_id_fkey"
            columns: ["media_file_id"]
            isOneToOne: false
            referencedRelation: "media_files"
            referencedColumns: ["id"]
          },
        ]
      }
      media_upload_counters: {
        Row: {
          last_seq: number
          upload_date: string
          user_id: string
        }
        Insert: {
          last_seq?: number
          upload_date: string
          user_id: string
        }
        Update: {
          last_seq?: number
          upload_date?: string
          user_id?: string
        }
        Relationships: []
      }
      messaging_cache: {
        Row: {
          conversation_id: string
          created_at: string | null
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          participant_avatar: string | null
          participant_id: string | null
          participant_name: string | null
          platform: string
          social_account_id: string
          unread_count: number | null
          updated_at: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          participant_avatar?: string | null
          participant_id?: string | null
          participant_name?: string | null
          platform: string
          social_account_id: string
          unread_count?: number | null
          updated_at?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          participant_avatar?: string | null
          participant_id?: string | null
          participant_name?: string | null
          platform?: string
          social_account_id?: string
          unread_count?: number | null
          updated_at?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messaging_cache_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      messenger_auto_replies: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          keywords: string[] | null
          name: string
          platform: string
          reply_message: string
          rule_type: string
          schedule_days: number[] | null
          schedule_end: string | null
          schedule_start: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          name: string
          platform: string
          reply_message: string
          rule_type: string
          schedule_days?: number[] | null
          schedule_end?: string | null
          schedule_start?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          name?: string
          platform?: string
          reply_message?: string
          rule_type?: string
          schedule_days?: number[] | null
          schedule_end?: string | null
          schedule_start?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      messenger_auto_reply_usage: {
        Row: {
          auto_reply_rule_id: string
          conversation_id: string | null
          id: string
          triggered_at: string
          user_id: string
        }
        Insert: {
          auto_reply_rule_id: string
          conversation_id?: string | null
          id?: string
          triggered_at?: string
          user_id: string
        }
        Update: {
          auto_reply_rule_id?: string
          conversation_id?: string | null
          id?: string
          triggered_at?: string
          user_id?: string
        }
        Relationships: []
      }
      node_execution_logs: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          execution_id: string
          id: string
          input_data: Json | null
          node_id: string
          node_label: string | null
          node_type: string
          output_data: Json | null
          started_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          execution_id: string
          id?: string
          input_data?: Json | null
          node_id: string
          node_label?: string | null
          node_type: string
          output_data?: Json | null
          started_at?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          execution_id?: string
          id?: string
          input_data?: Json | null
          node_id?: string
          node_label?: string | null
          node_type?: string
          output_data?: Json | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "node_execution_logs_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "workflow_executions"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_reads: {
        Row: {
          dismissed_at: string | null
          id: string
          metadata: Json | null
          notification_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          dismissed_at?: string | null
          id?: string
          metadata?: Json | null
          notification_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          dismissed_at?: string | null
          id?: string
          metadata?: Json | null
          notification_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "system_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_apps: {
        Row: {
          client_id: string
          created_at: string | null
          description: string | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          name: string
          redirect_uris: string[]
          updated_at: string | null
        }
        Insert: {
          client_id: string
          created_at?: string | null
          description?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          redirect_uris?: string[]
          updated_at?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string | null
          description?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          redirect_uris?: string[]
          updated_at?: string | null
        }
        Relationships: []
      }
      oauth_pending_facebook_selections: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ig_standalone_json: Json
          pages_json: Json
          provider_token: string
          social_profile_id: string | null
          target_platform: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          ig_standalone_json?: Json
          pages_json?: Json
          provider_token: string
          social_profile_id?: string | null
          target_platform: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          ig_standalone_json?: Json
          pages_json?: Json
          provider_token?: string
          social_profile_id?: string | null
          target_platform?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_pending_instagram_selections: {
        Row: {
          created_at: string
          expires_at: string
          expires_in: number
          id: string
          ig_candidates_json: Json
          long_lived_token: string
          social_profile_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          expires_in?: number
          id?: string
          ig_candidates_json?: Json
          long_lived_token: string
          social_profile_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          expires_in?: number
          id?: string
          ig_candidates_json?: Json
          long_lived_token?: string
          social_profile_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      oauth_redirect_requests: {
        Row: {
          admin_note: string | null
          created_at: string | null
          id: string
          oauth_app_id: string
          redirect_uri: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string
        }
        Insert: {
          admin_note?: string | null
          created_at?: string | null
          id?: string
          oauth_app_id: string
          redirect_uri: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id: string
        }
        Update: {
          admin_note?: string | null
          created_at?: string | null
          id?: string
          oauth_app_id?: string
          redirect_uri?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_redirect_requests_oauth_app_id_fkey"
            columns: ["oauth_app_id"]
            isOneToOne: false
            referencedRelation: "oauth_apps"
            referencedColumns: ["id"]
          },
        ]
      }
      observability_alert_configs: {
        Row: {
          cooldown_minutes: number
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          last_triggered_at: string | null
          metric_name: string | null
          metric_type: string | null
          name: string
          notification_channels: string[]
          notification_emails: string[] | null
          threshold_operator: string
          threshold_value: number
          time_window_minutes: number
          trigger_type: string
          updated_at: string
          webhook_url: string | null
        }
        Insert: {
          cooldown_minutes?: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_triggered_at?: string | null
          metric_name?: string | null
          metric_type?: string | null
          name: string
          notification_channels?: string[]
          notification_emails?: string[] | null
          threshold_operator?: string
          threshold_value: number
          time_window_minutes?: number
          trigger_type: string
          updated_at?: string
          webhook_url?: string | null
        }
        Update: {
          cooldown_minutes?: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_triggered_at?: string | null
          metric_name?: string | null
          metric_type?: string | null
          name?: string
          notification_channels?: string[]
          notification_emails?: string[] | null
          threshold_operator?: string
          threshold_value?: number
          time_window_minutes?: number
          trigger_type?: string
          updated_at?: string
          webhook_url?: string | null
        }
        Relationships: []
      }
      observability_alert_history: {
        Row: {
          alert_config_id: string | null
          alert_name: string
          created_at: string
          details: Json | null
          id: string
          is_resolved: boolean
          metric_name: string | null
          metric_type: string | null
          notification_channel: string | null
          notification_error: string | null
          notification_sent: boolean
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          threshold_value: number
          trigger_type: string
          triggered_value: number
        }
        Insert: {
          alert_config_id?: string | null
          alert_name: string
          created_at?: string
          details?: Json | null
          id?: string
          is_resolved?: boolean
          metric_name?: string | null
          metric_type?: string | null
          notification_channel?: string | null
          notification_error?: string | null
          notification_sent?: boolean
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          threshold_value: number
          trigger_type: string
          triggered_value: number
        }
        Update: {
          alert_config_id?: string | null
          alert_name?: string
          created_at?: string
          details?: Json | null
          id?: string
          is_resolved?: boolean
          metric_name?: string | null
          metric_type?: string | null
          notification_channel?: string | null
          notification_error?: string | null
          notification_sent?: boolean
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          threshold_value?: number
          trigger_type?: string
          triggered_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "observability_alert_history_alert_config_id_fkey"
            columns: ["alert_config_id"]
            isOneToOne: false
            referencedRelation: "observability_alert_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      observability_health_snapshots: {
        Row: {
          active_errors_count: number
          captured_at: string
          cron_health: number | null
          database_health: number | null
          edge_functions_health: number | null
          failed_functions_count: number
          id: string
          metrics_breakdown: Json | null
          overall_health_score: number
          slow_queries_count: number
          token_health: number | null
          unhealthy_tokens_count: number
        }
        Insert: {
          active_errors_count?: number
          captured_at?: string
          cron_health?: number | null
          database_health?: number | null
          edge_functions_health?: number | null
          failed_functions_count?: number
          id?: string
          metrics_breakdown?: Json | null
          overall_health_score: number
          slow_queries_count?: number
          token_health?: number | null
          unhealthy_tokens_count?: number
        }
        Update: {
          active_errors_count?: number
          captured_at?: string
          cron_health?: number | null
          database_health?: number | null
          edge_functions_health?: number | null
          failed_functions_count?: number
          id?: string
          metrics_breakdown?: Json | null
          overall_health_score?: number
          slow_queries_count?: number
          token_health?: number | null
          unhealthy_tokens_count?: number
        }
        Relationships: []
      }
      observability_metrics: {
        Row: {
          avg_duration_ms: number | null
          created_at: string
          error_count: number
          id: string
          max_duration_ms: number | null
          metadata: Json | null
          metric_category: string
          metric_name: string
          metric_type: string
          min_duration_ms: number | null
          success_count: number
          total_count: number
          window_end: string
          window_start: string
        }
        Insert: {
          avg_duration_ms?: number | null
          created_at?: string
          error_count?: number
          id?: string
          max_duration_ms?: number | null
          metadata?: Json | null
          metric_category?: string
          metric_name: string
          metric_type: string
          min_duration_ms?: number | null
          success_count?: number
          total_count?: number
          window_end: string
          window_start: string
        }
        Update: {
          avg_duration_ms?: number | null
          created_at?: string
          error_count?: number
          id?: string
          max_duration_ms?: number | null
          metadata?: Json | null
          metric_category?: string
          metric_name?: string
          metric_type?: string
          min_duration_ms?: number | null
          success_count?: number
          total_count?: number
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      password_reset_otps: {
        Row: {
          attempts: number | null
          code_hash: string
          created_at: string | null
          email: string
          expires_at: string
          id: string
          purpose: string
          used: boolean | null
        }
        Insert: {
          attempts?: number | null
          code_hash: string
          created_at?: string | null
          email: string
          expires_at: string
          id?: string
          purpose?: string
          used?: boolean | null
        }
        Update: {
          attempts?: number | null
          code_hash?: string
          created_at?: string | null
          email?: string
          expires_at?: string
          id?: string
          purpose?: string
          used?: boolean | null
        }
        Relationships: []
      }
      platform_posts: {
        Row: {
          created_at: string | null
          error_message: string | null
          id: string
          platform: string
          platform_post_id: string | null
          platform_post_url: string | null
          post_id: string
          posted_at: string | null
          response_data: Json | null
          social_account_id: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          platform: string
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_id: string
          posted_at?: string | null
          response_data?: Json | null
          social_account_id?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          platform?: string
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_id?: string
          posted_at?: string | null
          response_data?: Json | null
          social_account_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_posts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_templates: {
        Row: {
          caption: string
          created_at: string
          hashtags: string[] | null
          id: string
          name: string
          platforms: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          caption: string
          created_at?: string
          hashtags?: string[] | null
          id?: string
          name: string
          platforms?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          caption?: string
          created_at?: string
          hashtags?: string[] | null
          id?: string
          name?: string
          platforms?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      posts: {
        Row: {
          caption: string | null
          created_at: string | null
          id: string
          media_file_ids: string[] | null
          metadata: Json | null
          platforms: string[]
          posted_at: string | null
          scheduled_at: string | null
          source: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          id?: string
          media_file_ids?: string[] | null
          metadata?: Json | null
          platforms: string[]
          posted_at?: string | null
          scheduled_at?: string | null
          source?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          id?: string
          media_file_ids?: string[] | null
          metadata?: Json | null
          platforms?: string[]
          posted_at?: string | null
          scheduled_at?: string | null
          source?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          admin_notified_at: string | null
          ai_model: string | null
          api_key: string | null
          avatar_url: string | null
          created_at: string | null
          email: string
          email_notifications_enabled: boolean | null
          full_name: string | null
          id: string
          notification_sound_enabled: boolean | null
          post_failure_notifications_enabled: boolean | null
          post_success_notifications_enabled: boolean | null
          preferred_timezone: string | null
          referral_code: string | null
          referred_by: string | null
          updated_at: string | null
        }
        Insert: {
          admin_notified_at?: string | null
          ai_model?: string | null
          api_key?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email: string
          email_notifications_enabled?: boolean | null
          full_name?: string | null
          id: string
          notification_sound_enabled?: boolean | null
          post_failure_notifications_enabled?: boolean | null
          post_success_notifications_enabled?: boolean | null
          preferred_timezone?: string | null
          referral_code?: string | null
          referred_by?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_notified_at?: string | null
          ai_model?: string | null
          api_key?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email?: string
          email_notifications_enabled?: boolean | null
          full_name?: string | null
          id?: string
          notification_sound_enabled?: boolean | null
          post_failure_notifications_enabled?: boolean | null
          post_success_notifications_enabled?: boolean | null
          preferred_timezone?: string | null
          referral_code?: string | null
          referred_by?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      provider_api_keys: {
        Row: {
          api_key: string
          created_by: string | null
          id: string
          provider_code: string
          updated_at: string | null
        }
        Insert: {
          api_key: string
          created_by?: string | null
          id?: string
          provider_code: string
          updated_at?: string | null
        }
        Update: {
          api_key?: string
          created_by?: string | null
          id?: string
          provider_code?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      rate_limit_buckets: {
        Row: {
          bucket_key: string
          count: number
          expires_at: string
          window_start: string
        }
        Insert: {
          bucket_key: string
          count?: number
          expires_at?: string
          window_start?: string
        }
        Update: {
          bucket_key?: string
          count?: number
          expires_at?: string
          window_start?: string
        }
        Relationships: []
      }
      rate_limit_settings: {
        Row: {
          created_at: string
          display_name: string
          endpoint: string
          id: string
          is_active: boolean
          max_requests: number
          updated_at: string
          window_minutes: number
        }
        Insert: {
          created_at?: string
          display_name: string
          endpoint: string
          id?: string
          is_active?: boolean
          max_requests?: number
          updated_at?: string
          window_minutes?: number
        }
        Update: {
          created_at?: string
          display_name?: string
          endpoint?: string
          id?: string
          is_active?: boolean
          max_requests?: number
          updated_at?: string
          window_minutes?: number
        }
        Relationships: []
      }
      referrals: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          referral_code: string
          referred_user_id: string | null
          referrer_id: string
          reward_amount: number | null
          reward_type: string | null
          rewarded_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          referral_code: string
          referred_user_id?: string | null
          referrer_id: string
          reward_amount?: number | null
          reward_type?: string | null
          rewarded_at?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          referral_code?: string
          referred_user_id?: string | null
          referrer_id?: string
          reward_amount?: number | null
          reward_type?: string | null
          rewarded_at?: string | null
          status?: string
        }
        Relationships: []
      }
      saved_field_suggestions: {
        Row: {
          created_at: string
          field_type: string
          id: string
          last_used_at: string
          platform: string | null
          use_count: number
          user_id: string
          value: string
        }
        Insert: {
          created_at?: string
          field_type: string
          id?: string
          last_used_at?: string
          platform?: string | null
          use_count?: number
          user_id: string
          value: string
        }
        Update: {
          created_at?: string
          field_type?: string
          id?: string
          last_used_at?: string
          platform?: string | null
          use_count?: number
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      scheduled_emails: {
        Row: {
          admin_id: string
          attachments: Json | null
          bcc_email: string | null
          cc_email: string | null
          created_at: string
          error_message: string | null
          from_email: string
          html_body: string
          id: string
          reply_to_message_id: string | null
          scheduled_at: string
          sent_at: string | null
          signature_id: string | null
          status: string
          subject: string
          text_body: string | null
          to_email: string
          updated_at: string
        }
        Insert: {
          admin_id: string
          attachments?: Json | null
          bcc_email?: string | null
          cc_email?: string | null
          created_at?: string
          error_message?: string | null
          from_email: string
          html_body: string
          id?: string
          reply_to_message_id?: string | null
          scheduled_at: string
          sent_at?: string | null
          signature_id?: string | null
          status?: string
          subject: string
          text_body?: string | null
          to_email: string
          updated_at?: string
        }
        Update: {
          admin_id?: string
          attachments?: Json | null
          bcc_email?: string | null
          cc_email?: string | null
          created_at?: string
          error_message?: string | null
          from_email?: string
          html_body?: string
          id?: string
          reply_to_message_id?: string | null
          scheduled_at?: string
          sent_at?: string | null
          signature_id?: string | null
          status?: string
          subject?: string
          text_body?: string | null
          to_email?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_emails_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "admin_inbox_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_emails_signature_id_fkey"
            columns: ["signature_id"]
            isOneToOne: false
            referencedRelation: "email_signatures"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          access_token: string
          account_metadata: Json | null
          alerts_snoozed: boolean | null
          avatar_url: string | null
          connected_at: string | null
          failure_count: number | null
          id: string
          ig_auth_type: string | null
          is_active: boolean | null
          last_alert_sent_at: string | null
          last_refresh_attempt_at: string | null
          last_refresh_error: string | null
          needs_reauth: boolean | null
          platform: string
          platform_user_id: string
          platform_username: string | null
          refresh_token: string | null
          social_profile_id: string | null
          token_expires_at: string | null
          updated_at: string | null
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          access_token: string
          account_metadata?: Json | null
          alerts_snoozed?: boolean | null
          avatar_url?: string | null
          connected_at?: string | null
          failure_count?: number | null
          id?: string
          ig_auth_type?: string | null
          is_active?: boolean | null
          last_alert_sent_at?: string | null
          last_refresh_attempt_at?: string | null
          last_refresh_error?: string | null
          needs_reauth?: boolean | null
          platform: string
          platform_user_id: string
          platform_username?: string | null
          refresh_token?: string | null
          social_profile_id?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          access_token?: string
          account_metadata?: Json | null
          alerts_snoozed?: boolean | null
          avatar_url?: string | null
          connected_at?: string | null
          failure_count?: number | null
          id?: string
          ig_auth_type?: string | null
          is_active?: boolean | null
          last_alert_sent_at?: string | null
          last_refresh_attempt_at?: string | null
          last_refresh_error?: string | null
          needs_reauth?: boolean | null
          platform?: string
          platform_user_id?: string
          platform_username?: string | null
          refresh_token?: string | null
          social_profile_id?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_social_profile_id_fkey"
            columns: ["social_profile_id"]
            isOneToOne: false
            referencedRelation: "social_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      social_profiles: {
        Row: {
          created_at: string | null
          id: string
          is_public: boolean | null
          name: string
          share_token: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_public?: boolean | null
          name: string
          share_token?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_public?: boolean | null
          name?: string
          share_token?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          error: string | null
          event_id: string
          event_type: string
          processed_at: string | null
          received_at: string
          status: string
        }
        Insert: {
          error?: string | null
          event_id: string
          event_type: string
          processed_at?: string | null
          received_at?: string
          status?: string
        }
        Update: {
          error?: string | null
          event_id?: string
          event_type?: string
          processed_at?: string | null
          received_at?: string
          status?: string
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          created_at: string | null
          features: Json | null
          id: string
          is_active: boolean | null
          is_popular: boolean | null
          name: string
          price_monthly: number | null
          price_yearly: number | null
          profile_limit: number | null
          slug: string
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          features?: Json | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name: string
          price_monthly?: number | null
          price_yearly?: number | null
          profile_limit?: number | null
          slug: string
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          features?: Json | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name?: string
          price_monthly?: number | null
          price_yearly?: number | null
          profile_limit?: number | null
          slug?: string
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      support_messages: {
        Row: {
          admin_reply: string | null
          created_at: string | null
          email: string | null
          id: string
          message: string
          mobile: string | null
          replied_at: string | null
          replied_by: string | null
          status: string | null
          subject: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          admin_reply?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          message: string
          mobile?: string | null
          replied_at?: string | null
          replied_by?: string | null
          status?: string | null
          subject: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          admin_reply?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          message?: string
          mobile?: string | null
          replied_at?: string | null
          replied_by?: string | null
          status?: string | null
          subject?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      support_tickets: {
        Row: {
          assigned_to: string | null
          attachments: Json | null
          category: string
          created_at: string
          description: string
          id: string
          last_response_at: string | null
          priority: string | null
          resolved_at: string | null
          status: string | null
          subject: string
          ticket_number: number
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          attachments?: Json | null
          category: string
          created_at?: string
          description: string
          id?: string
          last_response_at?: string | null
          priority?: string | null
          resolved_at?: string | null
          status?: string | null
          subject: string
          ticket_number?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          attachments?: Json | null
          category?: string
          created_at?: string
          description?: string
          id?: string
          last_response_at?: string | null
          priority?: string | null
          resolved_at?: string | null
          status?: string | null
          subject?: string
          ticket_number?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      system_health_snapshots: {
        Row: {
          active_sessions: number | null
          active_subscriptions: number | null
          ai_avg_response_time: number | null
          ai_calls_today: number | null
          ai_error_rate: number | null
          alerts_active: number | null
          alerts_triggered: string[] | null
          api_avg_response_time: number | null
          api_error_rate: number | null
          api_requests_per_minute: number | null
          captured_at: string
          db_connections: number | null
          db_connections_active: number | null
          db_query_time_avg: number | null
          db_size_gb: number | null
          edge_function_avg_duration: number | null
          edge_function_errors: number | null
          edge_function_invocations: number | null
          health_score: number | null
          health_status: string | null
          id: string
          metadata: Json | null
          mrr: number | null
          new_signups_today: number | null
          storage_total_gb: number | null
          storage_used_gb: number | null
          total_users: number | null
        }
        Insert: {
          active_sessions?: number | null
          active_subscriptions?: number | null
          ai_avg_response_time?: number | null
          ai_calls_today?: number | null
          ai_error_rate?: number | null
          alerts_active?: number | null
          alerts_triggered?: string[] | null
          api_avg_response_time?: number | null
          api_error_rate?: number | null
          api_requests_per_minute?: number | null
          captured_at?: string
          db_connections?: number | null
          db_connections_active?: number | null
          db_query_time_avg?: number | null
          db_size_gb?: number | null
          edge_function_avg_duration?: number | null
          edge_function_errors?: number | null
          edge_function_invocations?: number | null
          health_score?: number | null
          health_status?: string | null
          id?: string
          metadata?: Json | null
          mrr?: number | null
          new_signups_today?: number | null
          storage_total_gb?: number | null
          storage_used_gb?: number | null
          total_users?: number | null
        }
        Update: {
          active_sessions?: number | null
          active_subscriptions?: number | null
          ai_avg_response_time?: number | null
          ai_calls_today?: number | null
          ai_error_rate?: number | null
          alerts_active?: number | null
          alerts_triggered?: string[] | null
          api_avg_response_time?: number | null
          api_error_rate?: number | null
          api_requests_per_minute?: number | null
          captured_at?: string
          db_connections?: number | null
          db_connections_active?: number | null
          db_query_time_avg?: number | null
          db_size_gb?: number | null
          edge_function_avg_duration?: number | null
          edge_function_errors?: number | null
          edge_function_invocations?: number | null
          health_score?: number | null
          health_status?: string | null
          id?: string
          metadata?: Json | null
          mrr?: number | null
          new_signups_today?: number | null
          storage_total_gb?: number | null
          storage_used_gb?: number | null
          total_users?: number | null
        }
        Relationships: []
      }
      system_logs: {
        Row: {
          category: string
          created_at: string
          id: string
          level: string
          message: string
          metadata: Json | null
          source: string
          user_id: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          level?: string
          message: string
          metadata?: Json | null
          source: string
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          level?: string
          message?: string
          metadata?: Json | null
          source?: string
          user_id?: string | null
        }
        Relationships: []
      }
      system_notifications: {
        Row: {
          action_label: string | null
          action_url: string | null
          created_at: string
          created_by: string | null
          dismissible: boolean | null
          expires_at: string | null
          id: string
          message: string
          metadata: Json | null
          priority: string | null
          published_at: string | null
          target_roles: string[] | null
          target_territories: string[] | null
          target_type: string | null
          target_users: string[] | null
          title: string
          total_reads: number | null
          total_recipients: number | null
          type: string | null
        }
        Insert: {
          action_label?: string | null
          action_url?: string | null
          created_at?: string
          created_by?: string | null
          dismissible?: boolean | null
          expires_at?: string | null
          id?: string
          message: string
          metadata?: Json | null
          priority?: string | null
          published_at?: string | null
          target_roles?: string[] | null
          target_territories?: string[] | null
          target_type?: string | null
          target_users?: string[] | null
          title: string
          total_reads?: number | null
          total_recipients?: number | null
          type?: string | null
        }
        Update: {
          action_label?: string | null
          action_url?: string | null
          created_at?: string
          created_by?: string | null
          dismissible?: boolean | null
          expires_at?: string | null
          id?: string
          message?: string
          metadata?: Json | null
          priority?: string | null
          published_at?: string | null
          target_roles?: string[] | null
          target_territories?: string[] | null
          target_type?: string | null
          target_users?: string[] | null
          title?: string
          total_reads?: number | null
          total_recipients?: number | null
          type?: string | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      threads_mentions: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assigned_to: string | null
          created_at: string
          has_reply: boolean
          id: string
          labels: string[]
          last_synced_at: string | null
          mention_author_avatar_url: string | null
          mention_author_id: string | null
          mention_author_username: string | null
          mention_id: string
          mention_permalink: string | null
          mention_text: string | null
          mentioned_at: string | null
          notified_at: string | null
          raw_response: Json
          replied_at: string | null
          replied_by: string | null
          reply_error: string | null
          reply_permalink: string | null
          reply_platform_post_id: string | null
          reply_text: string | null
          sentiment: string
          social_account_id: string
          source: string
          status: string
          threads_media_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          created_at?: string
          has_reply?: boolean
          id?: string
          labels?: string[]
          last_synced_at?: string | null
          mention_author_avatar_url?: string | null
          mention_author_id?: string | null
          mention_author_username?: string | null
          mention_id: string
          mention_permalink?: string | null
          mention_text?: string | null
          mentioned_at?: string | null
          notified_at?: string | null
          raw_response?: Json
          replied_at?: string | null
          replied_by?: string | null
          reply_error?: string | null
          reply_permalink?: string | null
          reply_platform_post_id?: string | null
          reply_text?: string | null
          sentiment?: string
          social_account_id: string
          source?: string
          status?: string
          threads_media_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          created_at?: string
          has_reply?: boolean
          id?: string
          labels?: string[]
          last_synced_at?: string | null
          mention_author_avatar_url?: string | null
          mention_author_id?: string | null
          mention_author_username?: string | null
          mention_id?: string
          mention_permalink?: string | null
          mention_text?: string | null
          mentioned_at?: string | null
          notified_at?: string | null
          raw_response?: Json
          replied_at?: string | null
          replied_by?: string | null
          reply_error?: string | null
          reply_permalink?: string | null
          reply_platform_post_id?: string | null
          reply_text?: string | null
          sentiment?: string
          social_account_id?: string
          source?: string
          status?: string
          threads_media_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "threads_mentions_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_mentions_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      threads_recent_searches: {
        Row: {
          created_at: string
          id: string
          query: string
          search_type: string
          since_date: string | null
          until_date: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          query: string
          search_type?: string
          since_date?: string | null
          until_date?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          query?: string
          search_type?: string
          since_date?: string | null
          until_date?: string | null
          user_id?: string
        }
        Relationships: []
      }
      threads_reply_cache: {
        Row: {
          created_at: string
          has_replies: boolean | null
          hide_status: string | null
          id: string
          is_reply: boolean | null
          is_reply_owned_by_me: boolean | null
          media_id: string
          media_type: string | null
          media_url: string | null
          parent_id: string | null
          permalink: string | null
          raw_data: Json
          reply_audience: string | null
          reply_id: string
          root_post_id: string | null
          social_account_id: string
          status: string
          text: string | null
          thumbnail_url: string | null
          timestamp: string | null
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          created_at?: string
          has_replies?: boolean | null
          hide_status?: string | null
          id?: string
          is_reply?: boolean | null
          is_reply_owned_by_me?: boolean | null
          media_id: string
          media_type?: string | null
          media_url?: string | null
          parent_id?: string | null
          permalink?: string | null
          raw_data?: Json
          reply_audience?: string | null
          reply_id: string
          root_post_id?: string | null
          social_account_id: string
          status?: string
          text?: string | null
          thumbnail_url?: string | null
          timestamp?: string | null
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          created_at?: string
          has_replies?: boolean | null
          hide_status?: string | null
          id?: string
          is_reply?: boolean | null
          is_reply_owned_by_me?: boolean | null
          media_id?: string
          media_type?: string | null
          media_url?: string | null
          parent_id?: string | null
          permalink?: string | null
          raw_data?: Json
          reply_audience?: string | null
          reply_id?: string
          root_post_id?: string | null
          social_account_id?: string
          status?: string
          text?: string | null
          thumbnail_url?: string | null
          timestamp?: string | null
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "threads_reply_cache_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_reply_cache_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_activities: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json | null
          id: string
          ticket_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ticket_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_activities_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_messages: {
        Row: {
          attachments: Json | null
          created_at: string
          id: string
          is_internal: boolean | null
          message: string
          ticket_id: string
          user_id: string
        }
        Insert: {
          attachments?: Json | null
          created_at?: string
          id?: string
          is_internal?: boolean | null
          message: string
          ticket_id: string
          user_id: string
        }
        Update: {
          attachments?: Json | null
          created_at?: string
          id?: string
          is_internal?: boolean | null
          message?: string
          ticket_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      tier_rate_limits: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          is_active: boolean
          max_requests_per_day: number
          max_requests_per_hour: number
          plan_slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          is_active?: boolean
          max_requests_per_day?: number
          max_requests_per_hour?: number
          plan_slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          is_active?: boolean
          max_requests_per_day?: number
          max_requests_per_hour?: number
          plan_slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      tiktok_api_analytics_cache: {
        Row: {
          cache_key: string
          created_at: string
          cursor: string | null
          expires_at: string
          has_more: boolean | null
          id: string
          posts_data: Json | null
          profile_data: Json | null
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cache_key: string
          created_at?: string
          cursor?: string | null
          expires_at: string
          has_more?: boolean | null
          id?: string
          posts_data?: Json | null
          profile_data?: Json | null
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cache_key?: string
          created_at?: string
          cursor?: string | null
          expires_at?: string
          has_more?: boolean | null
          id?: string
          posts_data?: Json | null
          profile_data?: Json | null
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      token_refresh_history: {
        Row: {
          account_id: string
          created_at: string
          cron_category: string | null
          duration_ms: number | null
          error_message: string | null
          id: string
          platform: string
          platform_username: string | null
          status: string
          trigger_type: string
        }
        Insert: {
          account_id: string
          created_at?: string
          cron_category?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          platform: string
          platform_username?: string | null
          status: string
          trigger_type?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          cron_category?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          platform?: string
          platform_username?: string | null
          status?: string
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_refresh_history_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_refresh_history_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ai_model_overrides: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          model: string
          provider: string
          reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          model: string
          provider: string
          reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          model?: string
          provider?: string
          reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_blog_post_reads: {
        Row: {
          blog_post_id: string
          id: string
          read_at: string | null
          user_id: string
        }
        Insert: {
          blog_post_id: string
          id?: string
          read_at?: string | null
          user_id: string
        }
        Update: {
          blog_post_id?: string
          id?: string
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_blog_post_reads_blog_post_id_fkey"
            columns: ["blog_post_id"]
            isOneToOne: false
            referencedRelation: "blog_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_connectors: {
        Row: {
          connected_at: string | null
          connector_type: string
          created_at: string | null
          id: string
          is_connected: boolean | null
          slack_user_id: string | null
          updated_at: string | null
          user_id: string
          workspace_name: string | null
        }
        Insert: {
          connected_at?: string | null
          connector_type: string
          created_at?: string | null
          id?: string
          is_connected?: boolean | null
          slack_user_id?: string | null
          updated_at?: string | null
          user_id: string
          workspace_name?: string | null
        }
        Update: {
          connected_at?: string | null
          connector_type?: string
          created_at?: string | null
          id?: string
          is_connected?: boolean | null
          slack_user_id?: string | null
          updated_at?: string | null
          user_id?: string
          workspace_name?: string | null
        }
        Relationships: []
      }
      user_credits: {
        Row: {
          balance: number
          created_at: string
          id: string
          total_purchased: number
          total_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_credits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_credits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_feature_overrides: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          expires_at: string | null
          feature_key: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled: boolean
          expires_at?: string | null
          feature_key: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          expires_at?: string | null
          feature_key?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_feature_overrides_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notification_preferences: {
        Row: {
          created_at: string | null
          id: string
          notify_post_failed: boolean | null
          notify_post_success: boolean | null
          notify_scheduled: boolean | null
          slack_notifications: boolean | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          notify_post_failed?: boolean | null
          notify_post_success?: boolean | null
          notify_scheduled?: boolean | null
          slack_notifications?: boolean | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          notify_post_failed?: boolean | null
          notify_post_success?: boolean | null
          notify_scheduled?: boolean | null
          slack_notifications?: boolean | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_notification_reads: {
        Row: {
          id: string
          notification_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          id?: string
          notification_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          id?: string
          notification_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "admin_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      user_quotas: {
        Row: {
          created_at: string | null
          daily_reset_date: string | null
          id: string
          max_media_uploads_per_day: number | null
          max_posts_per_day: number | null
          max_posts_per_month: number | null
          max_profiles: number | null
          max_social_accounts: number | null
          media_daily_reset_date: string | null
          media_uploads_today: number | null
          posts_this_month: number | null
          posts_today: number | null
          quota_reset_date: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          daily_reset_date?: string | null
          id?: string
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_profiles?: number | null
          max_social_accounts?: number | null
          media_daily_reset_date?: string | null
          media_uploads_today?: number | null
          posts_this_month?: number | null
          posts_today?: number | null
          quota_reset_date?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          daily_reset_date?: string | null
          id?: string
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_profiles?: number | null
          max_social_accounts?: number | null
          media_daily_reset_date?: string | null
          media_uploads_today?: number | null
          posts_this_month?: number | null
          posts_today?: number | null
          quota_reset_date?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_quotas_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_quotas_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_rate_limits: {
        Row: {
          created_at: string
          created_by: string | null
          endpoint: string
          expires_at: string | null
          id: string
          max_requests: number
          reason: string | null
          updated_at: string
          user_id: string
          window_minutes: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          endpoint: string
          expires_at?: string | null
          id?: string
          max_requests: number
          reason?: string | null
          updated_at?: string
          user_id: string
          window_minutes?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          endpoint?: string
          expires_at?: string | null
          id?: string
          max_requests?: number
          reason?: string | null
          updated_at?: string
          user_id?: string
          window_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_rate_limits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          coupon_id: string | null
          created_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan_id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          coupon_id?: string | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          coupon_id?: string | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_subscriptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      video_processing_presets: {
        Row: {
          compress_max_size_mb: number | null
          compress_quality: number | null
          created_at: string
          crop_aspect_ratio: string | null
          id: string
          is_default: boolean | null
          name: string
          platform: string
          preset_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          compress_max_size_mb?: number | null
          compress_quality?: number | null
          created_at?: string
          crop_aspect_ratio?: string | null
          id?: string
          is_default?: boolean | null
          name: string
          platform: string
          preset_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          compress_max_size_mb?: number | null
          compress_quality?: number | null
          created_at?: string
          crop_aspect_ratio?: string | null
          id?: string
          is_default?: boolean | null
          name?: string
          platform?: string
          preset_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_agents: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          current_conversations: number | null
          display_name: string
          id: string
          last_seen_at: string | null
          max_conversations: number | null
          status: string
          updated_at: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          current_conversations?: number | null
          display_name: string
          id?: string
          last_seen_at?: string | null
          max_conversations?: number | null
          status?: string
          updated_at?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          current_conversations?: number | null
          display_name?: string
          id?: string
          last_seen_at?: string | null
          max_conversations?: number | null
          status?: string
          updated_at?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_agents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_assignment_history: {
        Row: {
          action: string
          conversation_id: string
          created_at: string | null
          from_agent_id: string | null
          id: string
          performed_by: string | null
          reason: string | null
          to_agent_id: string | null
        }
        Insert: {
          action: string
          conversation_id: string
          created_at?: string | null
          from_agent_id?: string | null
          id?: string
          performed_by?: string | null
          reason?: string | null
          to_agent_id?: string | null
        }
        Update: {
          action?: string
          conversation_id?: string
          created_at?: string | null
          from_agent_id?: string | null
          id?: string
          performed_by?: string | null
          reason?: string | null
          to_agent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_assignment_history_from_agent_id_fkey"
            columns: ["from_agent_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_assignment_history_to_agent_id_fkey"
            columns: ["to_agent_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_auto_replies: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          keywords: string[] | null
          name: string
          reply_message: string
          rule_type: string
          schedule_days: number[] | null
          schedule_end: string | null
          schedule_start: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          name: string
          reply_message: string
          rule_type: string
          schedule_days?: number[] | null
          schedule_end?: string | null
          schedule_start?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          name?: string
          reply_message?: string
          rule_type?: string
          schedule_days?: number[] | null
          schedule_end?: string | null
          schedule_start?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_auto_reply_usage: {
        Row: {
          auto_reply_rule_id: string
          conversation_id: string | null
          id: string
          triggered_at: string
          user_id: string
        }
        Insert: {
          auto_reply_rule_id: string
          conversation_id?: string | null
          id?: string
          triggered_at?: string
          user_id: string
        }
        Update: {
          auto_reply_rule_id?: string
          conversation_id?: string | null
          id?: string
          triggered_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_broadcast_recipients: {
        Row: {
          broadcast_id: string
          contact_id: string
          created_at: string
          delivered_at: string | null
          error_message: string | null
          id: string
          phone_number: string
          sent_at: string | null
          status: string
        }
        Insert: {
          broadcast_id: string
          contact_id: string
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          phone_number: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          broadcast_id?: string
          contact_id?: string
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          phone_number?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_broadcast_recipients_broadcast_id_fkey"
            columns: ["broadcast_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_broadcasts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_broadcast_recipients_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_broadcasts: {
        Row: {
          created_at: string
          delivered_count: number
          failed_count: number
          id: string
          name: string
          recipient_count: number
          sent_count: number
          status: string
          template_components: Json | null
          template_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          delivered_count?: number
          failed_count?: number
          id?: string
          name: string
          recipient_count?: number
          sent_count?: number
          status?: string
          template_components?: Json | null
          template_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          delivered_count?: number
          failed_count?: number
          id?: string
          name?: string
          recipient_count?: number
          sent_count?: number
          status?: string
          template_components?: Json | null
          template_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_contact_group_members: {
        Row: {
          added_at: string
          contact_id: string
          group_id: string
          id: string
        }
        Insert: {
          added_at?: string
          contact_id: string
          group_id: string
          id?: string
        }
        Update: {
          added_at?: string
          contact_id?: string
          group_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_contact_group_members_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_contact_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contact_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_contact_groups: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_contacts: {
        Row: {
          avatar_url: string | null
          birthday: string | null
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          display_name: string | null
          email: string | null
          first_name: string | null
          id: string
          job_title: string | null
          last_message_at: string | null
          last_name: string | null
          notes: string | null
          phone_number: string
          phone_secondary: string | null
          street: string | null
          tags: string[] | null
          updated_at: string
          user_id: string
          website: string | null
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          birthday?: string | null
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          job_title?: string | null
          last_message_at?: string | null
          last_name?: string | null
          notes?: string | null
          phone_number: string
          phone_secondary?: string | null
          street?: string | null
          tags?: string[] | null
          updated_at?: string
          user_id: string
          website?: string | null
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          birthday?: string | null
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          job_title?: string | null
          last_message_at?: string | null
          last_name?: string | null
          notes?: string | null
          phone_number?: string
          phone_secondary?: string | null
          street?: string | null
          tags?: string[] | null
          updated_at?: string
          user_id?: string
          website?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversation_assignments: {
        Row: {
          agent_id: string | null
          assigned_at: string | null
          assigned_by: string | null
          conversation_cache_id: string | null
          conversation_id: string
          created_at: string | null
          id: string
          notes: string | null
          unassigned_at: string | null
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          agent_id?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          conversation_cache_id?: string | null
          conversation_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          unassigned_at?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          agent_id?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          conversation_cache_id?: string | null
          conversation_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          unassigned_at?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_assignments_conversation_workspace_fkey"
            columns: ["conversation_cache_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "messaging_cache"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_conversation_cache_id_fkey"
            columns: ["conversation_cache_id"]
            isOneToOne: false
            referencedRelation: "messaging_cache"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversation_label_assignments: {
        Row: {
          conversation_id: string
          created_at: string | null
          id: string
          label_id: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string | null
          id?: string
          label_id: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string | null
          id?: string
          label_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_conversation_label_assignments_label_id_fkey"
            columns: ["label_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversation_labels"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversation_labels: {
        Row: {
          color: string
          created_at: string | null
          id: string
          name: string
          user_id: string
        }
        Insert: {
          color?: string
          created_at?: string | null
          id?: string
          name: string
          user_id: string
        }
        Update: {
          color?: string
          created_at?: string | null
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_deals: {
        Row: {
          amount: number
          assigned_to: string | null
          contact_id: string
          conversation_cache_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          id: string
          pipeline_id: string
          position: number
          stage_id: string
          status: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          amount?: number
          assigned_to?: string | null
          contact_id: string
          conversation_cache_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          pipeline_id: string
          position?: number
          stage_id: string
          status?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          amount?: number
          assigned_to?: string | null
          contact_id?: string
          conversation_cache_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          pipeline_id?: string
          position?: number
          stage_id?: string
          status?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_deals_contact_workspace_fkey"
            columns: ["contact_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_conversation_workspace_fkey"
            columns: ["conversation_cache_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "messaging_cache"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_pipeline_workspace_fkey"
            columns: ["pipeline_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_pipelines"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_stage_pipeline_workspace_fkey"
            columns: ["stage_id", "pipeline_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_pipeline_stages"
            referencedColumns: ["id", "pipeline_id", "workspace_id"]
          },
        ]
      }
      whatsapp_message_analytics: {
        Row: {
          avg_response_time_minutes: number | null
          conversations_opened: number
          created_at: string
          date: string
          id: string
          messages_received: number
          messages_sent: number
          social_account_id: string
          templates_sent: number
          user_id: string
        }
        Insert: {
          avg_response_time_minutes?: number | null
          conversations_opened?: number
          created_at?: string
          date: string
          id?: string
          messages_received?: number
          messages_sent?: number
          social_account_id: string
          templates_sent?: number
          user_id: string
        }
        Update: {
          avg_response_time_minutes?: number | null
          conversations_opened?: number
          created_at?: string
          date?: string
          id?: string
          messages_received?: number
          messages_sent?: number
          social_account_id?: string
          templates_sent?: number
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_message_templates: {
        Row: {
          components: Json
          created_at: string
          id: string
          meta_template_id: string | null
          social_account_id: string
          template_category: string
          template_language: string
          template_name: string
          template_status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          components?: Json
          created_at?: string
          id?: string
          meta_template_id?: string | null
          social_account_id: string
          template_category?: string
          template_language?: string
          template_name: string
          template_status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          components?: Json
          created_at?: string
          id?: string
          meta_template_id?: string | null
          social_account_id?: string
          template_category?: string
          template_language?: string
          template_name?: string
          template_status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_messages: {
        Row: {
          conversation_id: string
          created_at: string
          direction: string
          error_code: string | null
          error_message: string | null
          from_name: string | null
          from_phone: string | null
          id: string
          media_metadata: Json | null
          media_type: string | null
          media_url: string | null
          message_id: string | null
          message_text: string | null
          message_type: string
          social_account_id: string
          status: string
          timestamp: string
          to_phone: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          direction?: string
          error_code?: string | null
          error_message?: string | null
          from_name?: string | null
          from_phone?: string | null
          id?: string
          media_metadata?: Json | null
          media_type?: string | null
          media_url?: string | null
          message_id?: string | null
          message_text?: string | null
          message_type?: string
          social_account_id: string
          status?: string
          timestamp?: string
          to_phone?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          direction?: string
          error_code?: string | null
          error_message?: string | null
          from_name?: string | null
          from_phone?: string | null
          id?: string
          media_metadata?: Json | null
          media_type?: string | null
          media_url?: string | null
          message_id?: string | null
          message_text?: string | null
          message_type?: string
          social_account_id?: string
          status?: string
          timestamp?: string
          to_phone?: string | null
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_pipeline_stages: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          pipeline_id: string
          position: number
          stage_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          pipeline_id: string
          position?: number
          stage_type?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          pipeline_id?: string
          position?: number
          stage_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_stages_pipeline_workspace_fkey"
            columns: ["pipeline_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_pipelines"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      whatsapp_pipelines: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      whatsapp_quick_replies: {
        Row: {
          created_at: string | null
          id: string
          message: string
          shortcut: string | null
          sort_order: number | null
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          message: string
          shortcut?: string | null
          sort_order?: number | null
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          message?: string
          shortcut?: string | null
          sort_order?: number | null
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_quick_reply_usage: {
        Row: {
          conversation_id: string | null
          id: string
          quick_reply_id: string
          used_at: string
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          id?: string
          quick_reply_id: string
          used_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          id?: string
          quick_reply_id?: string
          used_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_scheduled_messages: {
        Row: {
          created_at: string | null
          error_message: string | null
          id: string
          media_type: string | null
          media_url: string | null
          message_text: string | null
          recipient_name: string | null
          recipient_phone: string
          scheduled_at: string
          sent_at: string | null
          social_account_id: string
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          media_type?: string | null
          media_url?: string | null
          message_text?: string | null
          recipient_name?: string | null
          recipient_phone: string
          scheduled_at: string
          sent_at?: string | null
          social_account_id: string
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          error_message?: string | null
          id?: string
          media_type?: string | null
          media_url?: string | null
          message_text?: string | null
          recipient_name?: string | null
          recipient_phone?: string
          scheduled_at?: string
          sent_at?: string | null
          social_account_id?: string
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_webhooks: {
        Row: {
          created_at: string | null
          events: string[] | null
          failure_count: number | null
          id: string
          is_active: boolean | null
          last_status_code: number | null
          last_triggered_at: string | null
          name: string
          secret: string | null
          updated_at: string | null
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          events?: string[] | null
          failure_count?: number | null
          id?: string
          is_active?: boolean | null
          last_status_code?: number | null
          last_triggered_at?: string | null
          name: string
          secret?: string | null
          updated_at?: string | null
          url: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          events?: string[] | null
          failure_count?: number | null
          id?: string
          is_active?: boolean | null
          last_status_code?: number | null
          last_triggered_at?: string | null
          name?: string
          secret?: string | null
          updated_at?: string | null
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      workflow_comments: {
        Row: {
          content: string
          created_at: string
          id: string
          is_resolved: boolean | null
          node_id: string | null
          position: Json | null
          updated_at: string
          user_id: string
          workflow_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          is_resolved?: boolean | null
          node_id?: string | null
          position?: Json | null
          updated_at?: string
          user_id: string
          workflow_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          is_resolved?: boolean | null
          node_id?: string | null
          position?: Json | null
          updated_at?: string
          user_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_comments_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_executions: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          execution_summary: Json | null
          id: string
          started_at: string | null
          status: string
          user_id: string
          workflow_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          execution_summary?: Json | null
          id?: string
          started_at?: string | null
          status?: string
          user_id: string
          workflow_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          execution_summary?: Json | null
          id?: string
          started_at?: string | null
          status?: string
          user_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_executions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_schedules: {
        Row: {
          created_at: string
          cron_expression: string
          id: string
          is_active: boolean | null
          last_run_at: string | null
          name: string | null
          next_run_at: string | null
          run_count: number | null
          timezone: string | null
          user_id: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          cron_expression: string
          id?: string
          is_active?: boolean | null
          last_run_at?: string | null
          name?: string | null
          next_run_at?: string | null
          run_count?: number | null
          timezone?: string | null
          user_id: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          cron_expression?: string
          id?: string
          is_active?: boolean | null
          last_run_at?: string | null
          name?: string | null
          next_run_at?: string | null
          run_count?: number | null
          timezone?: string | null
          user_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_schedules_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_templates: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          edges: Json
          icon: string | null
          id: string
          is_active: boolean | null
          is_featured: boolean | null
          name: string
          nodes: Json
          preview_image_url: string | null
          updated_at: string
          use_count: number | null
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          edges?: Json
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_featured?: boolean | null
          name: string
          nodes?: Json
          preview_image_url?: string | null
          updated_at?: string
          use_count?: number | null
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          edges?: Json
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_featured?: boolean | null
          name?: string
          nodes?: Json
          preview_image_url?: string | null
          updated_at?: string
          use_count?: number | null
        }
        Relationships: []
      }
      workflow_versions: {
        Row: {
          change_description: string | null
          created_at: string
          created_by: string | null
          edges: Json
          id: string
          nodes: Json
          version_number: number
          viewport: Json | null
          workflow_id: string
        }
        Insert: {
          change_description?: string | null
          created_at?: string
          created_by?: string | null
          edges: Json
          id?: string
          nodes: Json
          version_number: number
          viewport?: Json | null
          workflow_id: string
        }
        Update: {
          change_description?: string | null
          created_at?: string
          created_by?: string | null
          edges?: Json
          id?: string
          nodes?: Json
          version_number?: number
          viewport?: Json | null
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_versions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_webhooks: {
        Row: {
          created_at: string
          id: string
          is_active: boolean | null
          last_triggered_at: string | null
          name: string | null
          trigger_count: number | null
          user_id: string
          webhook_token: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          last_triggered_at?: string | null
          name?: string | null
          trigger_count?: number | null
          user_id: string
          webhook_token?: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          last_triggered_at?: string | null
          name?: string | null
          trigger_count?: number | null
          user_id?: string
          webhook_token?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_webhooks_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          edges: Json
          id: string
          is_public: boolean | null
          is_template: boolean | null
          name: string
          nodes: Json
          tags: string[] | null
          thumbnail_url: string | null
          updated_at: string
          user_id: string
          viewport: Json | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          edges?: Json
          id?: string
          is_public?: boolean | null
          is_template?: boolean | null
          name: string
          nodes?: Json
          tags?: string[] | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
          viewport?: Json | null
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          edges?: Json
          id?: string
          is_public?: boolean | null
          is_template?: boolean | null
          name?: string
          nodes?: Json
          tags?: string[] | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
          viewport?: Json | null
        }
        Relationships: []
      }
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          revoked_at: string | null
          role: string
          token_hash: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          revoked_at?: string | null
          role: string
          token_hash: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          revoked_at?: string | null
          role?: string
          token_hash?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          role: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          is_personal: boolean
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_personal?: boolean
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_personal?: boolean
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      hypopg_hidden_indexes: {
        Row: {
          am_name: unknown
          index_name: unknown
          indexrelid: unknown
          is_hypo: boolean | null
          schema_name: unknown
          table_name: unknown
        }
        Relationships: []
      }
      hypopg_list_indexes: {
        Row: {
          am_name: unknown
          index_name: string | null
          indexrelid: unknown
          schema_name: unknown
          table_name: unknown
        }
        Relationships: []
      }
      profiles_public: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          full_name: string | null
          id: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          full_name?: string | null
          id?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          full_name?: string | null
          id?: string | null
        }
        Relationships: []
      }
      public_social_accounts: {
        Row: {
          avatar_url: string | null
          id: string | null
          is_active: boolean | null
          platform: string | null
          platform_username: string | null
          social_profile_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          id?: string | null
          is_active?: boolean | null
          platform?: string | null
          platform_username?: string | null
          social_profile_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          id?: string | null
          is_active?: boolean | null
          platform?: string | null
          platform_username?: string | null
          social_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_social_profile_id_fkey"
            columns: ["social_profile_id"]
            isOneToOne: false
            referencedRelation: "social_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_workspace_invitation: {
        Args: { p_token: string }
        Returns: string
      }
      add_ticket_message: {
        Args: {
          p_attachments?: Json
          p_is_internal?: boolean
          p_message: string
          p_ticket_id: string
        }
        Returns: string
      }
      add_user_credits: {
        Args: {
          p_amount: number
          p_description?: string
          p_stripe_session_id?: string
          p_transaction_type?: string
          p_user_id: string
        }
        Returns: number
      }
      admin_get_profiles: {
        Args: { p_limit?: number; p_offset?: number; p_search?: string }
        Returns: {
          avatar_url: string
          created_at: string
          email: string
          full_name: string
          id: string
          referral_code: string
        }[]
      }
      algorithm_sign: {
        Args: { algorithm: string; secret: string; signables: string }
        Returns: string
      }
      assign_ticket: {
        Args: { p_assignee_id: string; p_ticket_id: string }
        Returns: boolean
      }
      calculate_health_score: {
        Args: {
          p_api_error_rate: number
          p_db_query_time: number
          p_edge_function_errors: number
          p_storage_percent: number
        }
        Returns: number
      }
      can_upload_media: { Args: { p_user_id: string }; Returns: boolean }
      check_rate_limit: {
        Args: {
          p_endpoint: string
          p_identifier: string
          p_max_requests: number
          p_window_seconds: number
        }
        Returns: Json
      }
      claim_ai_knowledge_excel_source: {
        Args: never
        Returns: {
          chunk_count: number | null
          created_at: string | null
          error: string | null
          file_name: string | null
          file_path: string | null
          id: string
          source_type: string | null
          status: string
          updated_at: string | null
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ai_knowledge_sources"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      cleanup_expired_otps: { Args: never; Returns: undefined }
      cleanup_old_health_data: {
        Args: never
        Returns: {
          edge_status_deleted: number
          logs_deleted: number
          snapshots_deleted: number
        }[]
      }
      cleanup_old_token_refresh_history: { Args: never; Returns: number }
      cleanup_rate_limit_buckets: { Args: never; Returns: number }
      create_default_whatsapp_pipeline: {
        Args: { p_workspace_id: string }
        Returns: string
      }
      create_support_ticket: {
        Args: {
          p_attachments?: Json
          p_category: string
          p_description: string
          p_priority?: string
          p_subject: string
        }
        Returns: string
      }
      ensure_personal_workspace: {
        Args: { p_user_id: string }
        Returns: string
      }
      generate_referral_code: { Args: never; Returns: string }
      get_active_ai_model_config: {
        Args: { p_feature?: string; p_user_id: string }
        Returns: {
          api_endpoint: string
          api_key_env_var: string
          api_type: string
          model_id: string
          model_name: string
          provider_code: string
          supports_streaming: boolean
        }[]
      }
      get_checklist_progress: {
        Args: never
        Returns: {
          completed_items: number
          progress_percentage: number
          total_items: number
        }[]
      }
      get_coupon_stats: {
        Args: { p_coupon_id: string }
        Returns: {
          avg_discount: number
          total_discount: number
          total_redemptions: number
          unique_users: number
        }[]
      }
      get_cron_jobs: {
        Args: never
        Returns: {
          active: boolean
          command: string
          database: string
          jobid: number
          jobname: string
          nodename: string
          nodeport: number
          schedule: string
          username: string
        }[]
      }
      get_cron_secret: { Args: never; Returns: string }
      get_edge_function_statuses: {
        Args: never
        Returns: {
          avg_execution_time_ms: number
          checked_at: string
          error_rate: number
          function_name: string
          invocations_last_hour: number
          last_error: string
          status: string
        }[]
      }
      get_email_stats: {
        Args: { p_days?: number }
        Returns: {
          click_rate: number
          delivered_rate: number
          open_rate: number
          total_sent: number
        }[]
      }
      get_health_history: {
        Args: { p_hours?: number }
        Returns: {
          active_sessions: number
          api_requests_per_minute: number
          captured_at: string
          health_score: number
          health_status: string
        }[]
      }
      get_latest_health_snapshot: {
        Args: never
        Returns: {
          active_sessions: number
          alerts_active: number
          api_requests_per_minute: number
          captured_at: string
          db_connections: number
          health_score: number
          health_status: string
          id: string
          mrr: number
          total_users: number
        }[]
      }
      get_my_notifications: {
        Args: { p_limit?: number; p_unread_only?: boolean }
        Returns: {
          action_label: string
          action_url: string
          dismissible: boolean
          expires_at: string
          id: string
          message: string
          priority: string
          published_at: string
          read_at: string
          title: string
          type: string
        }[]
      }
      get_notification_stats: {
        Args: { p_notification_id: string }
        Returns: {
          read_rate: number
          total_reads: number
          unique_readers: number
        }[]
      }
      get_system_logs_filtered: {
        Args: {
          p_hours?: number
          p_level?: string
          p_limit?: number
          p_service?: string
        }
        Returns: {
          component: string
          created_at: string
          error_code: string
          id: string
          level: string
          message: string
          service: string
          user_id: string
        }[]
      }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      hypopg: { Args: never; Returns: Record<string, unknown>[] }
      hypopg_create_index: {
        Args: { sql_order: string }
        Returns: Record<string, unknown>[]
      }
      hypopg_drop_index: { Args: { indexid: unknown }; Returns: boolean }
      hypopg_get_indexdef: { Args: { indexid: unknown }; Returns: string }
      hypopg_hidden_indexes: {
        Args: never
        Returns: {
          indexid: unknown
        }[]
      }
      hypopg_hide_index: { Args: { indexid: unknown }; Returns: boolean }
      hypopg_relation_size: { Args: { indexid: unknown }; Returns: number }
      hypopg_reset: { Args: never; Returns: undefined }
      hypopg_reset_index: { Args: never; Returns: undefined }
      hypopg_unhide_all_indexes: { Args: never; Returns: undefined }
      hypopg_unhide_index: { Args: { indexid: unknown }; Returns: boolean }
      increment_media_uploads: { Args: { p_user_id: string }; Returns: boolean }
      increment_template_use_count: {
        Args: { p_template_id: string }
        Returns: undefined
      }
      index_advisor: {
        Args: { query: string }
        Returns: {
          errors: string[]
          index_statements: string[]
          startup_cost_after: Json
          startup_cost_before: Json
          total_cost_after: Json
          total_cost_before: Json
        }[]
      }
      is_coupon_valid: {
        Args: { p_code: string; p_user_id?: string }
        Returns: boolean
      }
      is_workspace_member: {
        Args: { p_user_id?: string; p_workspace_id: string }
        Returns: boolean
      }
      log_admin_action: {
        Args: {
          p_action: string
          p_details?: Json
          p_resource_id?: string
          p_resource_type: string
        }
        Returns: string
      }
      log_email_sent: {
        Args: {
          p_provider_id?: string
          p_recipient_email: string
          p_recipient_id: string
          p_subject: string
          p_template_slug: string
        }
        Returns: string
      }
      log_system_event: {
        Args: {
          p_details?: Json
          p_error_code?: string
          p_error_message?: string
          p_level: string
          p_message: string
          p_service: string
          p_user_id?: string
        }
        Returns: string
      }
      mark_all_notifications_read: { Args: never; Returns: number }
      mark_notification_dismissed: {
        Args: { p_notification_id: string }
        Returns: boolean
      }
      mark_notification_read: {
        Args: { p_notification_id: string }
        Returns: boolean
      }
      match_ai_knowledge_chunks: {
        Args: {
          match_count?: number
          p_user_id: string
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          metadata: Json
          similarity: number
          source_id: string
        }[]
      }
      match_ai_knowledge_chunks_bge_m3: {
        Args: {
          match_count?: number
          p_user_id: string
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          metadata: Json
          similarity: number
          source_id: string
        }[]
      }
      match_ai_knowledge_graph_relations: {
        Args: {
          match_count?: number
          p_source_chunk_ids: string[]
          p_user_id: string
        }
        Returns: {
          relation: string
          source_name: string
          source_type: string
          target_name: string
          target_type: string
        }[]
      }
      move_whatsapp_deal: {
        Args: { p_deal_id: string; p_position: number; p_stage_id: string }
        Returns: undefined
      }
      next_media_seq: {
        Args: { p_upload_date: string; p_user_id: string }
        Returns: number
      }
      prune_ai_knowledge_entities: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      prune_all_ai_knowledge_entities: { Args: never; Returns: number }
      redeem_coupon: {
        Args: { p_code: string; p_subscription_id?: string; p_user_id: string }
        Returns: string
      }
      render_email_template: {
        Args: { p_slug: string; p_variables: Json }
        Returns: {
          html: string
          subject: string
        }[]
      }
      set_user_quotas_for_plan: {
        Args: { p_plan_slug: string; p_user_id: string }
        Returns: undefined
      }
      sign: {
        Args: { algorithm?: string; payload: Json; secret: string }
        Returns: string
      }
      toggle_checklist_item: {
        Args: { p_completed: boolean; p_item_id: string }
        Returns: boolean
      }
      toggle_cron_job: {
        Args: { _active: boolean; _jobid: number }
        Returns: undefined
      }
      try_cast_double: { Args: { inp: string }; Returns: number }
      update_email_status: {
        Args: {
          p_error_message?: string
          p_provider_id: string
          p_status: string
        }
        Returns: boolean
      }
      update_ticket_status: {
        Args: { p_status: string; p_ticket_id: string }
        Returns: boolean
      }
      url_decode: { Args: { data: string }; Returns: string }
      url_encode: { Args: { data: string }; Returns: string }
      use_credits: {
        Args: { p_amount: number; p_description?: string; p_user_id: string }
        Returns: boolean
      }
      verify: {
        Args: { algorithm?: string; secret: string; token: string }
        Returns: {
          header: Json
          payload: Json
          valid: boolean
        }[]
      }
      workspace_role: {
        Args: { p_user_id?: string; p_workspace_id: string }
        Returns: string
      }
    }
    Enums: {
      app_role: "user" | "admin" | "subscriber" | "support"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["user", "admin", "subscriber", "support"],
    },
  },
} as const

