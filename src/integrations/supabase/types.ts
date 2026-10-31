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
      graphql: {
        Args: {
          operationName?: string
          extensions?: Json
          variables?: Json
          query?: string
        }
        Returns: Json
      }
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
      user_ai_provider_keys: {
        Row: {
          id: string
          user_id: string
          provider_code: string
          credentials_secret_id: string | null
          key_hint: string | null
          status: string
          last_verified_at: string | null
          last_error_code: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          provider_code: string
          credentials_secret_id?: string | null
          key_hint?: string | null
          status?: string
          last_verified_at?: string | null
          last_error_code?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          provider_code?: string
          credentials_secret_id?: string | null
          key_hint?: string | null
          status?: string
          last_verified_at?: string | null
          last_error_code?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_ai_provider_keys_provider_code_fkey"
            columns: ["provider_code"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["provider_code"]
          },
        ]
      }
      user_ai_routing_preferences: {
        Row: {
          user_id: string
          capability: string
          mode: string
          preferred_provider_code: string | null
          preferred_model_id: string | null
          allow_platform_fallback: boolean
          updated_at: string
        }
        Insert: {
          user_id: string
          capability: string
          mode: string
          preferred_provider_code?: string | null
          preferred_model_id?: string | null
          allow_platform_fallback?: boolean
          updated_at?: string
        }
        Update: {
          user_id?: string
          capability?: string
          mode?: string
          preferred_provider_code?: string | null
          preferred_model_id?: string | null
          allow_platform_fallback?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      ai_provider_waitlist: {
        Row: {
          user_id: string
          provider_code: string
          created_at: string
        }
        Insert: {
          user_id: string
          provider_code: string
          created_at?: string
        }
        Update: {
          user_id?: string
          provider_code?: string
          created_at?: string
        }
        Relationships: []
      }

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
          escalation_timeout_minutes: number
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
          web_search_enabled: boolean
        }
        Insert: {
          admin_phone_numbers?: string[]
          business_profile_text?: string | null
          created_at?: string | null
          daily_message_cap?: number
          default_mode?: string
          escalation_timeout_minutes?: number
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
          web_search_enabled?: boolean
        }
        Update: {
          admin_phone_numbers?: string[]
          business_profile_text?: string | null
          created_at?: string | null
          daily_message_cap?: number
          default_mode?: string
          escalation_timeout_minutes?: number
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
          web_search_enabled?: boolean
        }
        Relationships: []
      }
      ai_agent_logs: {
        Row: {
          completion_tokens: number | null
          conversation_id: string | null
          created_at: string | null
          dry_run: boolean | null
          error: string | null
          id: string
          idempotency_key: string | null
          inbound_text: string | null
          intent: string | null
          latency_ms: number | null
          platform: string | null
          prompt_tokens: number | null
          reply_text: string | null
          retrieved_chunk_ids: string[] | null
          social_account_id: string | null
          status: string | null
          tool_calls: Json | null
          triage_fast_path: boolean | null
          used_model: string | null
          user_id: string
        }
        Insert: {
          completion_tokens?: number | null
          conversation_id?: string | null
          created_at?: string | null
          dry_run?: boolean | null
          error?: string | null
          id?: string
          idempotency_key?: string | null
          inbound_text?: string | null
          intent?: string | null
          latency_ms?: number | null
          platform?: string | null
          prompt_tokens?: number | null
          reply_text?: string | null
          retrieved_chunk_ids?: string[] | null
          social_account_id?: string | null
          status?: string | null
          tool_calls?: Json | null
          triage_fast_path?: boolean | null
          used_model?: string | null
          user_id: string
        }
        Update: {
          completion_tokens?: number | null
          conversation_id?: string | null
          created_at?: string | null
          dry_run?: boolean | null
          error?: string | null
          id?: string
          idempotency_key?: string | null
          inbound_text?: string | null
          intent?: string | null
          latency_ms?: number | null
          platform?: string | null
          prompt_tokens?: number | null
          reply_text?: string | null
          retrieved_chunk_ids?: string[] | null
          social_account_id?: string | null
          status?: string | null
          tool_calls?: Json | null
          triage_fast_path?: boolean | null
          used_model?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_agent_test_cases: {
        Row: {
          created_at: string
          expected: Json
          id: string
          message: string
          platform: string
          position: number
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expected?: Json
          id?: string
          message: string
          platform: string
          position?: number
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expected?: Json
          id?: string
          message?: string
          platform?: string
          position?: number
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_test_cases_account_same_owner_platform"
            columns: ["social_account_id", "user_id", "platform"]
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
        ]
      }
      ai_agent_test_runs: {
        Row: {
          finished_at: string | null
          id: string
          platform: string
          results: Json
          social_account_id: string
          started_at: string
          status: string
          summary: Json
          user_id: string
        }
        Insert: {
          finished_at?: string | null
          id?: string
          platform: string
          results?: Json
          social_account_id: string
          started_at?: string
          status?: string
          summary?: Json
          user_id: string
        }
        Update: {
          finished_at?: string | null
          id?: string
          platform?: string
          results?: Json
          social_account_id?: string
          started_at?: string
          status?: string
          summary?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_test_runs_account_same_owner_platform"
            columns: ["social_account_id", "user_id", "platform"]
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
        ]
      }
      ai_agent_tools: {
        Row: {
          admin_only: boolean | null
          auth_strategy: string
          connection_id: string | null
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
          auth_strategy?: string
          connection_id?: string | null
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
          auth_strategy?: string
          connection_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: "ai_agent_tools_connection_id_fkey"
            columns: ["connection_id"]
            referencedRelation: "connector_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversation_modes: {
        Row: {
          conversation_id: string
          created_at: string | null
          expires_at: string | null
          handoff_summary: string | null
          handoff_summary_at: string | null
          id: string
          mode: string
          platform: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string | null
          expires_at?: string | null
          handoff_summary?: string | null
          handoff_summary_at?: string | null
          id?: string
          mode: string
          platform: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string | null
          expires_at?: string | null
          handoff_summary?: string | null
          handoff_summary_at?: string | null
          id?: string
          mode?: string
          platform?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_generation_jobs: {
        Row: {
          created_at: string
          credential_source: string
          error: string | null
          id: string
          media_file_id: string | null
          modality: string
          model_id: string
          params: Json
          provider: string
          provider_job_id: string | null
          result_url: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_source: string
          error?: string | null
          id?: string
          media_file_id?: string | null
          modality: string
          model_id: string
          params?: Json
          provider: string
          provider_job_id?: string | null
          result_url?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_source?: string
          error?: string | null
          id?: string
          media_file_id?: string | null
          modality?: string
          model_id?: string
          params?: Json
          provider?: string
          provider_job_id?: string | null
          result_url?: string | null
          status?: string
          updated_at?: string
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
            referencedRelation: "ai_knowledge_chunks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_relations_source_entity_id_fkey"
            columns: ["source_entity_id"]
            referencedRelation: "ai_knowledge_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_relations_target_entity_id_fkey"
            columns: ["target_entity_id"]
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
          visibility: string
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
          visibility?: string
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
          visibility?: string
        }
        Relationships: []
      }
      ai_website_setup_jobs: {
        Row: {
          id: string
          user_id: string
          source_id: string
          social_account_id: string
          platform: string
          status: string
          result: Json | null
          error: string | null
          attempts: number
          lease_token: string | null
          lease_expires_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          source_id: string
          social_account_id: string
          platform: string
          status?: string
          result?: Json | null
          error?: string | null
          attempts?: number
          lease_token?: string | null
          lease_expires_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          source_id?: string
          social_account_id?: string
          platform?: string
          status?: string
          result?: Json | null
          error?: string | null
          attempts?: number
          lease_token?: string | null
          lease_expires_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          { foreignKeyName: "ai_website_setup_jobs_source_id_fkey"; columns: ["source_id"]; isOneToOne: false; referencedRelation: "ai_knowledge_sources"; referencedColumns: ["id"] },
          { foreignKeyName: "ai_website_setup_jobs_social_account_id_fkey"; columns: ["social_account_id"]; isOneToOne: false; referencedRelation: "social_accounts"; referencedColumns: ["id"] },
        ]
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
          metadata: Json
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
          metadata?: Json
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
          metadata?: Json
          model_id?: string
          name?: string
          provider_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_models_provider_id_fkey"
            columns: ["provider_id"]
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
          auth_type: string
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
          auth_type?: string
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
          auth_type?: string
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
          ip_address: unknown | null
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
          ip_address?: unknown | null
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
          ip_address?: unknown | null
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
      connector_call_logs: {
        Row: {
          action_name: string
          auth_strategy: string
          connection_id: string | null
          connector_type: string
          created_at: string
          error_code: string | null
          id: string
          latency_ms: number | null
          partner_key_id: string | null
          request_id: string | null
          social_account_id: string | null
          source: string
          status: string
          tool_id: string | null
          workspace_id: string
        }
        Insert: {
          action_name: string
          auth_strategy: string
          connection_id?: string | null
          connector_type: string
          created_at?: string
          error_code?: string | null
          id?: string
          latency_ms?: number | null
          partner_key_id?: string | null
          request_id?: string | null
          social_account_id?: string | null
          source: string
          status: string
          tool_id?: string | null
          workspace_id: string
        }
        Update: {
          action_name?: string
          auth_strategy?: string
          connection_id?: string | null
          connector_type?: string
          created_at?: string
          error_code?: string | null
          id?: string
          latency_ms?: number | null
          partner_key_id?: string | null
          request_id?: string | null
          social_account_id?: string | null
          source?: string
          status?: string
          tool_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_call_logs_connection_id_fkey"
            columns: ["connection_id"]
            referencedRelation: "connector_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_call_logs_tool_id_fkey"
            columns: ["tool_id"]
            referencedRelation: "ai_agent_tools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_call_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_workflow_events: {
        Row: {
          author_key: string
          author_username: string | null
          comment_text: string | null
          created_at: string
          dm_status: string
          error_message: string | null
          external_comment_id: string
          external_post_id: string | null
          id: string
          platform: string
          public_reply_id: string | null
          public_reply_status: string
          rule_id: string
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          author_key: string
          author_username?: string | null
          comment_text?: string | null
          created_at?: string
          dm_status: string
          error_message?: string | null
          external_comment_id: string
          external_post_id?: string | null
          id?: string
          platform: string
          public_reply_id?: string | null
          public_reply_status: string
          rule_id: string
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          author_key?: string
          author_username?: string | null
          comment_text?: string | null
          created_at?: string
          dm_status?: string
          error_message?: string | null
          external_comment_id?: string
          external_post_id?: string | null
          id?: string
          platform?: string
          public_reply_id?: string | null
          public_reply_status?: string
          rule_id?: string
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cwe_account_owner"
            columns: ["social_account_id", "user_id", "platform"]
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
          {
            foreignKeyName: "cwe_rule_owner"
            columns: ["rule_id", "user_id"]
            referencedRelation: "comment_workflow_rules"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      comment_workflow_rules: {
        Row: {
          created_at: string
          dm_message: string | null
          id: string
          is_active: boolean
          keywords: string[]
          match_type: string
          media_file_id: string | null
          name: string
          platform: string
          public_replies: string[]
          send_once_per_user: boolean
          social_account_id: string
          target_post_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dm_message?: string | null
          id?: string
          is_active?: boolean
          keywords?: string[]
          match_type: string
          media_file_id?: string | null
          name: string
          platform: string
          public_replies?: string[]
          send_once_per_user?: boolean
          social_account_id: string
          target_post_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dm_message?: string | null
          id?: string
          is_active?: boolean
          keywords?: string[]
          match_type?: string
          media_file_id?: string | null
          name?: string
          platform?: string
          public_replies?: string[]
          send_once_per_user?: boolean
          social_account_id?: string
          target_post_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cwr_account_owner"
            columns: ["social_account_id", "user_id", "platform"]
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
          {
            foreignKeyName: "cwr_media_owner"
            columns: ["media_file_id", "user_id"]
            referencedRelation: "media_files"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      comment_workflow_usage: {
        Row: {
          author_key: string
          claimed_at: string
          external_post_id: string
          rule_id: string
        }
        Insert: {
          author_key: string
          claimed_at?: string
          external_post_id?: string
          rule_id: string
        }
        Update: {
          author_key?: string
          claimed_at?: string
          external_post_id?: string
          rule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_workflow_usage_rule_id_fkey"
            columns: ["rule_id"]
            referencedRelation: "comment_workflow_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_capture_coverage: {
        Row: {
          capture_ended_at: string
          capture_started_at: string
          captured_at: string
          captured_on: string
          created_at: string
          cursor_present: boolean | null
          exhausted: boolean
          gap_reason: string | null
          id: string
          job_generation: number
          oldest_returned_at: string | null
          ordering_verified: boolean
          source: string
          truncated: boolean
          updated_at: string
          user_id: string
          watchlist_id: string
        }
        Insert: {
          capture_ended_at: string
          capture_started_at: string
          captured_at?: string
          captured_on: string
          created_at?: string
          cursor_present?: boolean | null
          exhausted: boolean
          gap_reason?: string | null
          id?: string
          job_generation: number
          oldest_returned_at?: string | null
          ordering_verified?: boolean
          source: string
          truncated: boolean
          updated_at?: string
          user_id: string
          watchlist_id: string
        }
        Update: {
          capture_ended_at?: string
          capture_started_at?: string
          captured_at?: string
          captured_on?: string
          created_at?: string
          cursor_present?: boolean | null
          exhausted?: boolean
          gap_reason?: string | null
          id?: string
          job_generation?: number
          oldest_returned_at?: string | null
          ordering_verified?: boolean
          source?: string
          truncated?: boolean
          updated_at?: string
          user_id?: string
          watchlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_capture_coverage_owner_fkey"
            columns: ["watchlist_id", "user_id"]
            isOneToOne: false
            referencedRelation: "competitor_watchlist"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      competitor_media_snapshots: {
        Row: {
          caption: string | null
          capture_timezone: string
          captured_at: string
          captured_on: string
          comments_count: number | null
          created_at: string
          id: string
          ig_media_id: string
          like_count: number | null
          media_product_type: string | null
          media_type: string | null
          permalink: string | null
          published_at: string
          source: string
          status: string
          thumbnail_url: string | null
          user_id: string
          view_count: number | null
          watchlist_id: string
        }
        Insert: {
          caption?: string | null
          capture_timezone?: string
          captured_at?: string
          captured_on: string
          comments_count?: number | null
          created_at?: string
          id?: string
          ig_media_id: string
          like_count?: number | null
          media_product_type?: string | null
          media_type?: string | null
          permalink?: string | null
          published_at: string
          source: string
          status?: string
          thumbnail_url?: string | null
          user_id: string
          view_count?: number | null
          watchlist_id: string
        }
        Update: {
          caption?: string | null
          capture_timezone?: string
          captured_at?: string
          captured_on?: string
          comments_count?: number | null
          created_at?: string
          id?: string
          ig_media_id?: string
          like_count?: number | null
          media_product_type?: string | null
          media_type?: string | null
          permalink?: string | null
          published_at?: string
          source?: string
          status?: string
          thumbnail_url?: string | null
          user_id?: string
          view_count?: number | null
          watchlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_media_snapshots_owner_fkey"
            columns: ["watchlist_id", "user_id"]
            isOneToOne: false
            referencedRelation: "competitor_watchlist"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      competitor_profile_snapshots: {
        Row: {
          capture_timezone: string
          captured_at: string
          captured_on: string
          created_at: string
          followers_count: number | null
          id: string
          media_count: number | null
          source: string
          status: string
          user_id: string
          watchlist_id: string
        }
        Insert: {
          capture_timezone?: string
          captured_at?: string
          captured_on: string
          created_at?: string
          followers_count?: number | null
          id?: string
          media_count?: number | null
          source: string
          status?: string
          user_id: string
          watchlist_id: string
        }
        Update: {
          capture_timezone?: string
          captured_at?: string
          captured_on?: string
          created_at?: string
          followers_count?: number | null
          id?: string
          media_count?: number | null
          source?: string
          status?: string
          user_id?: string
          watchlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_profile_snapshots_owner_fkey"
            columns: ["watchlist_id", "user_id"]
            isOneToOne: false
            referencedRelation: "competitor_watchlist"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      competitor_watchlist: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string | null
          last_error: string | null
          last_error_code: string | null
          last_synced_at: string | null
          next_retry_at: string | null
          platform: string
          removed_at: string | null
          source: string | null
          status: string
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          last_error?: string | null
          last_error_code?: string | null
          last_synced_at?: string | null
          next_retry_at?: string | null
          platform?: string
          removed_at?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          last_error?: string | null
          last_error_code?: string | null
          last_synced_at?: string | null
          next_retry_at?: string | null
          platform?: string
          removed_at?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      connector_connections: {
        Row: {
          auth_strategy: string
          composio_auth_config_id: string
          composio_connected_account_id: string | null
          connected_at: string | null
          connector_type: string
          created_at: string
          external_account_id: string | null
          external_account_label: string | null
          failure_code: string | null
          id: string
          initiated_by: string | null
          last_used_at: string | null
          revoked_at: string | null
          state_nonce: string | null
          status: string
          tool_schema_cache: Json | null
          tool_schema_cached_at: string | null
          toolkit: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          auth_strategy?: string
          composio_auth_config_id: string
          composio_connected_account_id?: string | null
          connected_at?: string | null
          connector_type: string
          created_at?: string
          external_account_id?: string | null
          external_account_label?: string | null
          failure_code?: string | null
          id?: string
          initiated_by?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          state_nonce?: string | null
          status?: string
          tool_schema_cache?: Json | null
          tool_schema_cached_at?: string | null
          toolkit: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          auth_strategy?: string
          composio_auth_config_id?: string
          composio_connected_account_id?: string | null
          connected_at?: string | null
          connector_type?: string
          created_at?: string
          external_account_id?: string | null
          external_account_label?: string | null
          failure_code?: string | null
          id?: string
          initiated_by?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          state_nonce?: string | null
          status?: string
          tool_schema_cache?: Json | null
          tool_schema_cached_at?: string | null
          toolkit?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_subscription_id_fkey"
            columns: ["subscription_id"]
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_transactions_user_id_fkey"
            columns: ["user_id"]
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_logs_triggered_by_fkey"
            columns: ["triggered_by"]
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
            referencedRelation: "admin_inbox_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_drafts_signature_id_fkey"
            columns: ["signature_id"]
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
      higgsfield_connections: {
        Row: {
          access_token: string
          account_email: string | null
          account_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          meta: Json
          refresh_token: string | null
          scope: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          account_email?: string | null
          account_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          meta?: Json
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          account_email?: string | null
          account_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          meta?: Json
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ig_account_insight_daily: {
        Row: {
          accounts_engaged: number | null
          captured_at: string
          comments: number | null
          created_at: string
          follows: number | null
          id: string
          likes: number | null
          metric_date: string
          period_end: string | null
          period_start: string | null
          provider_date: string
          provider_timezone: string | null
          reach: number | null
          saves: number | null
          shares: number | null
          social_account_id: string
          status: string
          total_interactions: number | null
          unfollows: number | null
          updated_at: string
          user_id: string
          views: number | null
        }
        Insert: {
          accounts_engaged?: number | null
          captured_at?: string
          comments?: number | null
          created_at?: string
          follows?: number | null
          id?: string
          likes?: number | null
          metric_date: string
          period_end?: string | null
          period_start?: string | null
          provider_date: string
          provider_timezone?: string | null
          reach?: number | null
          saves?: number | null
          shares?: number | null
          social_account_id: string
          status?: string
          total_interactions?: number | null
          unfollows?: number | null
          updated_at?: string
          user_id: string
          views?: number | null
        }
        Update: {
          accounts_engaged?: number | null
          captured_at?: string
          comments?: number | null
          created_at?: string
          follows?: number | null
          id?: string
          likes?: number | null
          metric_date?: string
          period_end?: string | null
          period_start?: string | null
          provider_date?: string
          provider_timezone?: string | null
          reach?: number | null
          saves?: number | null
          shares?: number | null
          social_account_id?: string
          status?: string
          total_interactions?: number | null
          unfollows?: number | null
          updated_at?: string
          user_id?: string
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ig_account_insight_daily_account_owner_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      ig_account_profile_observations: {
        Row: {
          capture_timezone: string
          captured_at: string
          created_at: string
          followers_count: number | null
          id: string
          media_count: number | null
          observed_at: string
          observed_on: string
          social_account_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capture_timezone?: string
          captured_at?: string
          created_at?: string
          followers_count?: number | null
          id?: string
          media_count?: number | null
          observed_at: string
          observed_on: string
          social_account_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capture_timezone?: string
          captured_at?: string
          created_at?: string
          followers_count?: number | null
          id?: string
          media_count?: number | null
          observed_at?: string
          observed_on?: string
          social_account_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ig_account_profile_observations_account_owner_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      ig_media_insight_snapshots: {
        Row: {
          caption: string | null
          capture_timezone: string
          captured_at: string
          captured_on: string
          comments: number | null
          comments_count_public: number | null
          created_at: string
          follows: number | null
          id: string
          ig_media_id: string
          ig_reels_avg_watch_time_ms: number | null
          like_count_public: number | null
          likes: number | null
          media_product_type: string | null
          media_type: string | null
          permalink: string | null
          post_id: string | null
          product: string | null
          profile_visits: number | null
          published_at: string
          reach: number | null
          replies: number | null
          saved: number | null
          shares: number | null
          social_account_id: string
          status: string
          thumbnail_url: string | null
          total_interactions: number | null
          updated_at: string
          user_id: string
          views: number | null
        }
        Insert: {
          caption?: string | null
          capture_timezone?: string
          captured_at?: string
          captured_on: string
          comments?: number | null
          comments_count_public?: number | null
          created_at?: string
          follows?: number | null
          id?: string
          ig_media_id: string
          ig_reels_avg_watch_time_ms?: number | null
          like_count_public?: number | null
          likes?: number | null
          media_product_type?: string | null
          media_type?: string | null
          permalink?: string | null
          post_id?: string | null
          product?: string | null
          profile_visits?: number | null
          published_at: string
          reach?: number | null
          replies?: number | null
          saved?: number | null
          shares?: number | null
          social_account_id: string
          status?: string
          thumbnail_url?: string | null
          total_interactions?: number | null
          updated_at?: string
          user_id: string
          views?: number | null
        }
        Update: {
          caption?: string | null
          capture_timezone?: string
          captured_at?: string
          captured_on?: string
          comments?: number | null
          comments_count_public?: number | null
          created_at?: string
          follows?: number | null
          id?: string
          ig_media_id?: string
          ig_reels_avg_watch_time_ms?: number | null
          like_count_public?: number | null
          likes?: number | null
          media_product_type?: string | null
          media_type?: string | null
          permalink?: string | null
          post_id?: string | null
          product?: string | null
          profile_visits?: number | null
          published_at?: string
          reach?: number | null
          replies?: number | null
          saved?: number | null
          shares?: number | null
          social_account_id?: string
          status?: string
          thumbnail_url?: string | null
          total_interactions?: number | null
          updated_at?: string
          user_id?: string
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ig_media_insight_snapshots_account_owner_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "ig_media_insight_snapshots_post_owner_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
        ]
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
            referencedRelation: "mcp_oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      media_file_providers: {
        Row: {
          bytes: number | null
          created_at: string
          deleted_at: string | null
          deleted_reason: string | null
          delivery_url: string | null
          error: string | null
          id: string
          media_file_id: string
          mime_type: string | null
          object_key: string
          object_version: number
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          delivery_url?: string | null
          error?: string | null
          id?: string
          media_file_id: string
          mime_type?: string | null
          object_key: string
          object_version?: number
          provider: string
          status?: string
          updated_at?: string
        }
        Update: {
          bytes?: number | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          delivery_url?: string | null
          error?: string | null
          id?: string
          media_file_id?: string
          mime_type?: string | null
          object_key?: string
          object_version?: number
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_file_providers_media_file_id_fkey"
            columns: ["media_file_id"]
            referencedRelation: "media_files"
            referencedColumns: ["id"]
          },
        ]
      }
      media_files: {
        Row: {
          cloudinary_public_id: string | null
          created_at: string | null
          current_object_version: number
          file_path: string
          file_size: number | null
          file_type: string
          folder_path: string | null
          expires_at: string | null
          id: string
          keep_forever: boolean
          last_used_at: string | null
          metadata: Json | null
          mime_type: string | null
          platforms: string[] | null
          retention_attempts: number
          retention_claimed_at: string | null
          retention_next_attempt_at: string | null
          retention_state: string | null
          social_account_ids: string[] | null
          storage_bucket: string | null
          upload_date: string | null
          user_id: string
        }
        Insert: {
          cloudinary_public_id?: string | null
          created_at?: string | null
          current_object_version?: number
          file_path: string
          file_size?: number | null
          file_type: string
          expires_at?: string | null
          folder_path?: string | null
          id?: string
          keep_forever?: boolean
          last_used_at?: string | null
          metadata?: Json | null
          mime_type?: string | null
          platforms?: string[] | null
          retention_attempts?: number
          retention_claimed_at?: string | null
          retention_next_attempt_at?: string | null
          retention_state?: string | null
          social_account_ids?: string[] | null
          storage_bucket?: string | null
          upload_date?: string | null
          user_id: string
        }
        Update: {
          cloudinary_public_id?: string | null
          created_at?: string | null
          current_object_version?: number
          file_path?: string
          file_size?: number | null
          file_type?: string
          expires_at?: string | null
          folder_path?: string | null
          id?: string
          keep_forever?: boolean
          last_used_at?: string | null
          metadata?: Json | null
          mime_type?: string | null
          platforms?: string[] | null
          retention_attempts?: number
          retention_claimed_at?: string | null
          retention_next_attempt_at?: string | null
          retention_state?: string | null
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
            referencedRelation: "media_files"
            referencedColumns: ["id"]
          },
        ]
      }
      media_retention_settings: {
        Row: {
          id: number
          rollout_at: string
          delete_enabled: boolean
        }
        Insert: {
          id?: number
          rollout_at?: string
          delete_enabled?: boolean
        }
        Update: {
          id?: number
          rollout_at?: string
          delete_enabled?: boolean
        }
        Relationships: []
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
      meta_account_refresh_captures: {
        Row: {
          capture: Json
          capture_version: number
          captured_at: string
          created_at: string
          expires_at: string
          id: string
          operation: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capture: Json
          capture_version?: number
          captured_at: string
          created_at?: string
          expires_at: string
          id?: string
          operation: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capture?: Json
          capture_version?: number
          captured_at?: string
          created_at?: string
          expires_at?: string
          id?: string
          operation?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      meta_oauth_attempt_receipts: {
        Row: {
          attempt_id: string
          capability_generation: number | null
          committed_at: string
          companion_social_account_id: string | null
          connection_version: number | null
          credential_id: string | null
          credential_revision: number | null
          facebook_page_id: string | null
          facebook_user_id: string | null
          id: string
          instagram_user_id: string | null
          login_kind: string | null
          platform: string
          platform_user_id: string
          receipt: Json
          selection_key: string
          social_account_id: string | null
          user_id: string
        }
        Insert: {
          attempt_id: string
          capability_generation?: number | null
          committed_at?: string
          companion_social_account_id?: string | null
          connection_version?: number | null
          credential_id?: string | null
          credential_revision?: number | null
          facebook_page_id?: string | null
          facebook_user_id?: string | null
          id?: string
          instagram_user_id?: string | null
          login_kind?: string | null
          platform: string
          platform_user_id: string
          receipt: Json
          selection_key: string
          social_account_id?: string | null
          user_id: string
        }
        Update: {
          attempt_id?: string
          capability_generation?: number | null
          committed_at?: string
          companion_social_account_id?: string | null
          connection_version?: number | null
          credential_id?: string | null
          credential_revision?: number | null
          facebook_page_id?: string | null
          facebook_user_id?: string | null
          id?: string
          instagram_user_id?: string | null
          login_kind?: string | null
          platform?: string
          platform_user_id?: string
          receipt?: Json
          selection_key?: string
          social_account_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_oauth_attempt_receipts_account_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "meta_oauth_attempt_receipts_attempt_fkey"
            columns: ["attempt_id", "user_id"]
            isOneToOne: false
            referencedRelation: "meta_oauth_attempts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "meta_oauth_attempt_receipts_companion_fkey"
            columns: ["companion_social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      meta_oauth_attempts: {
        Row: {
          authority_progression: Json
          callback_deadline: string
          capture: Json
          capture_version: number
          captured_at: string
          claim_token: string | null
          claimed_at: string | null
          created_at: string
          flow: string
          id: string
          intended_social_profile_id: string | null
          intent: string
          linked_target_social_account_id: string | null
          nonce_digest: string
          pending_selection_id: string | null
          picker_deadline: string
          source_social_account_id: string | null
          status: string
          target_social_account_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          authority_progression?: Json
          callback_deadline: string
          capture: Json
          capture_version?: number
          captured_at: string
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          flow: string
          id?: string
          intended_social_profile_id?: string | null
          intent: string
          linked_target_social_account_id?: string | null
          nonce_digest: string
          pending_selection_id?: string | null
          picker_deadline: string
          source_social_account_id?: string | null
          status?: string
          target_social_account_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          authority_progression?: Json
          callback_deadline?: string
          capture?: Json
          capture_version?: number
          captured_at?: string
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          flow?: string
          id?: string
          intended_social_profile_id?: string | null
          intent?: string
          linked_target_social_account_id?: string | null
          nonce_digest?: string
          pending_selection_id?: string | null
          picker_deadline?: string
          source_social_account_id?: string | null
          status?: string
          target_social_account_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_oauth_attempts_linked_target_fkey"
            columns: ["linked_target_social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "meta_oauth_attempts_profile_fkey"
            columns: ["intended_social_profile_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_profiles"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "meta_oauth_attempts_source_fkey"
            columns: ["source_social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "meta_oauth_attempts_target_fkey"
            columns: ["target_social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
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
      oauth_clients: {
        Row: {
          client_id: string
          client_secret: string | null
          created_at: string
          id: string
          issuer: string
          provider_code: string
          redirect_uri: string
          registration_response: Json
        }
        Insert: {
          client_id: string
          client_secret?: string | null
          created_at?: string
          id?: string
          issuer: string
          provider_code: string
          redirect_uri: string
          registration_response?: Json
        }
        Update: {
          client_id?: string
          client_secret?: string | null
          created_at?: string
          id?: string
          issuer?: string
          provider_code?: string
          redirect_uri?: string
          registration_response?: Json
        }
        Relationships: []
      }
      oauth_pending_facebook_selections: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ig_standalone_json: Json
          meta_oauth_attempt_id: string | null
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
          meta_oauth_attempt_id?: string | null
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
          meta_oauth_attempt_id?: string | null
          pages_json?: Json
          provider_token?: string
          social_profile_id?: string | null
          target_platform?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_pending_facebook_selections_attempt_fkey"
            columns: ["meta_oauth_attempt_id", "user_id"]
            isOneToOne: false
            referencedRelation: "meta_oauth_attempts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      oauth_pending_instagram_selections: {
        Row: {
          created_at: string
          expires_at: string
          expires_in: number
          id: string
          ig_candidates_json: Json
          long_lived_token: string
          meta_oauth_attempt_id: string | null
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
          meta_oauth_attempt_id?: string | null
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
          meta_oauth_attempt_id?: string | null
          social_profile_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_pending_instagram_selections_attempt_fkey"
            columns: ["meta_oauth_attempt_id", "user_id"]
            isOneToOne: false
            referencedRelation: "meta_oauth_attempts"
            referencedColumns: ["id", "user_id"]
          },
        ]
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
            referencedRelation: "oauth_apps"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          code_verifier: string
          created_at: string
          expires_at: string
          provider_code: string
          redirect_uri: string
          return_to: string | null
          scope_kind: string
          state: string
          user_id: string | null
        }
        Insert: {
          code_verifier: string
          created_at?: string
          expires_at?: string
          provider_code: string
          redirect_uri: string
          return_to?: string | null
          scope_kind: string
          state: string
          user_id?: string | null
        }
        Update: {
          code_verifier?: string
          created_at?: string
          expires_at?: string
          provider_code?: string
          redirect_uri?: string
          return_to?: string | null
          scope_kind?: string
          state?: string
          user_id?: string | null
        }
        Relationships: []
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
      partner_api_idempotency: {
        Row: {
          attempt_token: string
          completed_at: string | null
          created_at: string
          expires_at: string
          http_status: number | null
          idempotency_key: string
          key_id: string
          locked_until: string | null
          request_hash: string
          response_body: Json | null
          state: string
        }
        Insert: {
          attempt_token?: string
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          http_status?: number | null
          idempotency_key: string
          key_id: string
          locked_until?: string | null
          request_hash: string
          response_body?: Json | null
          state: string
        }
        Update: {
          attempt_token?: string
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          http_status?: number | null
          idempotency_key?: string
          key_id?: string
          locked_until?: string | null
          request_hash?: string
          response_body?: Json | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_api_idempotency_key_id_fkey"
            columns: ["key_id"]
            referencedRelation: "partner_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          current_usage_count: number
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_reset_at: string
          last_used_at: string | null
          monthly_quota: number | null
          name: string
          rate_limit_per_min: number
          revoked_at: string | null
          revoked_by: string | null
          revoked_reason: string | null
          scopes: string[]
          social_account_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          current_usage_count?: number
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_reset_at?: string
          last_used_at?: string | null
          monthly_quota?: number | null
          name: string
          rate_limit_per_min?: number
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          scopes?: string[]
          social_account_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          current_usage_count?: number
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_reset_at?: string
          last_used_at?: string | null
          monthly_quota?: number | null
          name?: string
          rate_limit_per_min?: number
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          scopes?: string[]
          social_account_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_api_keys_account_in_workspace"
            columns: ["social_account_id", "workspace_id"]
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "partner_api_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_api_rate_buckets: {
        Row: {
          key_id: string
          request_count: number
          window_start: string
        }
        Insert: {
          key_id: string
          request_count?: number
          window_start: string
        }
        Update: {
          key_id?: string
          request_count?: number
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_api_rate_buckets_key_id_fkey"
            columns: ["key_id"]
            referencedRelation: "partner_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_api_usage: {
        Row: {
          action: string
          billable: boolean
          created_at: string
          error_code: string | null
          http_status: number
          id: string
          key_id: string
          workspace_id: string
        }
        Insert: {
          action: string
          billable?: boolean
          created_at?: string
          error_code?: string | null
          http_status: number
          id?: string
          key_id: string
          workspace_id: string
        }
        Update: {
          action?: string
          billable?: boolean
          created_at?: string
          error_code?: string | null
          http_status?: number
          id?: string
          key_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_api_usage_key_in_workspace"
            columns: ["key_id", "workspace_id"]
            referencedRelation: "partner_api_keys"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "partner_api_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      pending_agent_replies: {
        Row: {
          attempts: number
          claimed_at: string | null
          comment_id: string | null
          conversation_id: string
          created_at: string
          error: string | null
          generated_reply: string | null
          generated_tool_calls: Json | null
          id: string
          inbound_at: string
          inbound_text: string
          ingress_seq: number
          language_hint: string | null
          lease_expires_at: string | null
          media_caption: string | null
          media_expires_at: string | null
          media_kind: string | null
          media_url: string | null
          message_id: string
          platform: string
          recipient_id: string
          sent_at: string | null
          social_account_id: string
          status: string
          unread_attachments: number
          user_id: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          comment_id?: string | null
          conversation_id: string
          created_at?: string
          error?: string | null
          generated_reply?: string | null
          generated_tool_calls?: Json | null
          id?: string
          inbound_at: string
          inbound_text: string
          ingress_seq?: number
          language_hint?: string | null
          lease_expires_at?: string | null
          media_caption?: string | null
          media_expires_at?: string | null
          media_kind?: string | null
          media_url?: string | null
          message_id: string
          platform: string
          recipient_id: string
          sent_at?: string | null
          social_account_id: string
          status?: string
          unread_attachments?: number
          user_id: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          comment_id?: string | null
          conversation_id?: string
          created_at?: string
          error?: string | null
          generated_reply?: string | null
          generated_tool_calls?: Json | null
          id?: string
          inbound_at?: string
          inbound_text?: string
          ingress_seq?: number
          language_hint?: string | null
          lease_expires_at?: string | null
          media_caption?: string | null
          media_expires_at?: string | null
          media_kind?: string | null
          media_url?: string | null
          message_id?: string
          platform?: string
          recipient_id?: string
          sent_at?: string | null
          social_account_id?: string
          status?: string
          unread_attachments?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_agent_replies_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_posts_social_account_id_fkey"
            columns: ["social_account_id"]
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
          api_key_hash: string | null
          avatar_url: string | null
          created_at: string | null
          email: string
          email_notifications_enabled: boolean | null
          full_name: string | null
          id: string
          media_retention_days: number | null
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
          api_key_hash?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email: string
          email_notifications_enabled?: boolean | null
          full_name?: string | null
          id: string
          media_retention_days?: number | null
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
          api_key_hash?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email?: string
          email_notifications_enabled?: boolean | null
          full_name?: string | null
          id?: string
          media_retention_days?: number | null
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
          access_token: string | null
          account_id: string | null
          api_key: string | null
          auth_type: string
          created_by: string | null
          expires_at: string | null
          id: string
          meta: Json
          provider_code: string
          refresh_token: string | null
          scope: string | null
          updated_at: string | null
        }
        Insert: {
          access_token?: string | null
          account_id?: string | null
          api_key?: string | null
          auth_type?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          meta?: Json
          provider_code: string
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string | null
        }
        Update: {
          access_token?: string | null
          account_id?: string | null
          api_key?: string | null
          auth_type?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          meta?: Json
          provider_code?: string
          refresh_token?: string | null
          scope?: string | null
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
            referencedRelation: "admin_inbox_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_emails_signature_id_fkey"
            columns: ["signature_id"]
            referencedRelation: "email_signatures"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          access_token: string | null
          account_metadata: Json | null
          alerts_snoozed: boolean | null
          auth_provider: string
          avatar_url: string | null
          connected_at: string | null
          connection_id: string | null
          connection_mode: string | null
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
          access_token?: string | null
          account_metadata?: Json | null
          alerts_snoozed?: boolean | null
          auth_provider?: string
          avatar_url?: string | null
          connected_at?: string | null
          connection_id?: string | null
          connection_mode?: string | null
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
          access_token?: string | null
          account_metadata?: Json | null
          alerts_snoozed?: boolean | null
          auth_provider?: string
          avatar_url?: string | null
          connected_at?: string | null
          connection_id?: string | null
          connection_mode?: string | null
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
            referencedRelation: "social_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_account_capabilities: {
        Row: {
          created_at: string
          credential_generation: number
          credential_updated_at: string | null
          generation_reason: string | null
          granted_scopes: string[]
          last_read_error_code: string | null
          last_read_failed_at: string | null
          login_kind: string
          permission_read_state: string
          platform: string
          reconnected_at: string | null
          scopes_read_at: string | null
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_generation?: number
          credential_updated_at?: string | null
          generation_reason?: string | null
          granted_scopes?: string[]
          last_read_error_code?: string | null
          last_read_failed_at?: string | null
          login_kind: string
          permission_read_state?: string
          platform?: string
          reconnected_at?: string | null
          scopes_read_at?: string | null
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_generation?: number
          credential_updated_at?: string | null
          generation_reason?: string | null
          granted_scopes?: string[]
          last_read_error_code?: string | null
          last_read_failed_at?: string | null
          login_kind?: string
          permission_read_state?: string
          platform?: string
          reconnected_at?: string | null
          scopes_read_at?: string | null
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_account_capabilities_owner_fkey"
            columns: ["social_account_id", "user_id", "platform"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
        ]
      }
      facebook_user_credentials: {
        Row: {
          created_at: string
          id: string
          lifecycle: string
          provenance_captured_at: string | null
          provenance_source: string
          provider_user_id: string | null
          revision: number
          token: string
          token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          lifecycle?: string
          provenance_captured_at?: string | null
          provenance_source: string
          provider_user_id?: string | null
          revision?: number
          token: string
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          lifecycle?: string
          provenance_captured_at?: string | null
          provenance_source?: string
          provider_user_id?: string | null
          revision?: number
          token?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      facebook_user_credential_bindings: {
        Row: {
          connection_version: number
          created_at: string
          credential_id: string
          evidence_source: string
          platform: string
          social_account_id: string
          updated_at: string
          user_id: string
          verified_facebook_page_id: string | null
          verified_facebook_user_id: string | null
          verified_instagram_user_id: string | null
        }
        Insert: {
          connection_version?: number
          created_at?: string
          credential_id: string
          evidence_source: string
          platform: string
          social_account_id: string
          updated_at?: string
          user_id: string
          verified_facebook_page_id?: string | null
          verified_facebook_user_id?: string | null
          verified_instagram_user_id?: string | null
        }
        Update: {
          connection_version?: number
          created_at?: string
          credential_id?: string
          evidence_source?: string
          platform?: string
          social_account_id?: string
          updated_at?: string
          user_id?: string
          verified_facebook_page_id?: string | null
          verified_facebook_user_id?: string | null
          verified_instagram_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "facebook_user_credential_bindings_account_fkey"
            columns: ["social_account_id", "user_id", "platform"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
          {
            foreignKeyName: "facebook_user_credential_bindings_credential_fkey"
            columns: ["credential_id", "user_id"]
            isOneToOne: false
            referencedRelation: "facebook_user_credentials"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      instagram_account_credentials: {
        Row: {
          created_at: string
          credential_id: string
          platform: string
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_id: string
          platform?: string
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_id?: string
          platform?: string
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_account_credentials_capability_fkey"
            columns: ["social_account_id"]
            isOneToOne: true
            referencedRelation: "instagram_account_capabilities"
            referencedColumns: ["social_account_id"]
          },
          {
            foreignKeyName: "instagram_account_credentials_credential_fkey"
            columns: ["credential_id", "user_id"]
            isOneToOne: false
            referencedRelation: "facebook_user_credentials"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "instagram_account_credentials_owner_fkey"
            columns: ["social_account_id", "user_id", "platform"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
        ]
      }
      facebook_user_credential_connection_fences: {
        Row: {
          connection_version: number
          created_at: string
          platform: string
          social_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_version?: number
          created_at?: string
          platform: string
          social_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_version?: number
          created_at?: string
          platform?: string
          social_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "facebook_user_credential_connection_fences_account_fkey"
            columns: ["social_account_id", "user_id", "platform"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id", "platform"]
          },
        ]
      }
      instagram_collection_jobs: {
        Row: {
          attempts: number
          captured_on: string
          context_credential_generation: number | null
          context_login_kind: string | null
          context_viewer_social_account_id: string | null
          created_at: string
          due_at: string
          id: string
          job_generation: number
          last_attempt_at: string | null
          last_partial_at: string | null
          last_reason_code: string | null
          last_success_at: string | null
          lease_expires_at: string | null
          lease_token: string | null
          retry_at: string | null
          social_account_id: string | null
          status: string
          target_id: string
          target_kind: string
          updated_at: string
          user_id: string
          watchlist_id: string | null
        }
        Insert: {
          attempts?: number
          captured_on: string
          context_credential_generation?: number | null
          context_login_kind?: string | null
          context_viewer_social_account_id?: string | null
          created_at?: string
          due_at?: string
          id?: string
          job_generation?: number
          last_attempt_at?: string | null
          last_partial_at?: string | null
          last_reason_code?: string | null
          last_success_at?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          retry_at?: string | null
          social_account_id?: string | null
          status?: string
          target_id: string
          target_kind: string
          updated_at?: string
          user_id: string
          watchlist_id?: string | null
        }
        Update: {
          attempts?: number
          captured_on?: string
          context_credential_generation?: number | null
          context_login_kind?: string | null
          context_viewer_social_account_id?: string | null
          created_at?: string
          due_at?: string
          id?: string
          job_generation?: number
          last_attempt_at?: string | null
          last_partial_at?: string | null
          last_reason_code?: string | null
          last_success_at?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          retry_at?: string | null
          social_account_id?: string | null
          status?: string
          target_id?: string
          target_kind?: string
          updated_at?: string
          user_id?: string
          watchlist_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_collection_jobs_account_owner_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "instagram_collection_jobs_context_owner_fkey"
            columns: ["context_viewer_social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "instagram_collection_jobs_watchlist_owner_fkey"
            columns: ["watchlist_id", "user_id"]
            isOneToOne: false
            referencedRelation: "competitor_watchlist"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      instagram_collection_job_operations: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          job_generation: number
          job_id: string
          last_attempt_at: string | null
          operation_key: string
          operation_kind: string
          provider_date: string | null
          query_kind: string | null
          reason_code: string | null
          retry_at: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          job_generation: number
          job_id: string
          last_attempt_at?: string | null
          operation_key: string
          operation_kind: string
          provider_date?: string | null
          query_kind?: string | null
          reason_code?: string | null
          retry_at?: string | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          job_generation?: number
          job_id?: string
          last_attempt_at?: string | null
          operation_key?: string
          operation_kind?: string
          provider_date?: string | null
          query_kind?: string | null
          reason_code?: string | null
          retry_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_collection_job_operations_job_owner_fkey"
            columns: ["job_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_collection_jobs"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      instagram_collection_job_checkpoints: {
        Row: {
          inventory_cursor: string | null
          inventory_gap_reason: string | null
          inventory_oldest_returned_at: string | null
          inventory_pages_fetched: number
          inventory_partial: boolean
          inventory_remaining_ids: string[]
          inventory_truncated: boolean
          inventory_window_covered: boolean
          inventory_window_end: string | null
          inventory_window_start: string | null
          job_generation: number
          job_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          inventory_cursor?: string | null
          inventory_gap_reason?: string | null
          inventory_oldest_returned_at?: string | null
          inventory_pages_fetched?: number
          inventory_partial?: boolean
          inventory_remaining_ids?: string[]
          inventory_truncated?: boolean
          inventory_window_covered?: boolean
          inventory_window_end?: string | null
          inventory_window_start?: string | null
          job_generation: number
          job_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          inventory_cursor?: string | null
          inventory_gap_reason?: string | null
          inventory_oldest_returned_at?: string | null
          inventory_pages_fetched?: number
          inventory_partial?: boolean
          inventory_remaining_ids?: string[]
          inventory_truncated?: boolean
          inventory_window_covered?: boolean
          inventory_window_end?: string | null
          inventory_window_start?: string | null
          job_generation?: number
          job_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_collection_job_checkpoints_job_owner_fkey"
            columns: ["job_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_collection_jobs"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      instagram_collection_request_throttles: {
        Row: {
          accepted_count: number
          created_at: string
          last_accepted_at: string | null
          scope: string
          social_account_id: string | null
          target_id: string
          target_kind: string
          updated_at: string
          user_id: string
          watchlist_id: string | null
        }
        Insert: {
          accepted_count?: number
          created_at?: string
          last_accepted_at?: string | null
          scope?: string
          social_account_id?: string | null
          target_id: string
          target_kind: string
          updated_at?: string
          user_id: string
          watchlist_id?: string | null
        }
        Update: {
          accepted_count?: number
          created_at?: string
          last_accepted_at?: string | null
          scope?: string
          social_account_id?: string | null
          target_id?: string
          target_kind?: string
          updated_at?: string
          user_id?: string
          watchlist_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_collection_request_throttles_account_owner_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "instagram_collection_request_throttles_watchlist_owner_fkey"
            columns: ["watchlist_id", "user_id"]
            isOneToOne: false
            referencedRelation: "competitor_watchlist"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      instagram_collection_enqueue_sweeps: {
        Row: {
          captured_on: string
          completed_at: string | null
          enqueued_count: number
          expired_at: string | null
          last_reason_code: string | null
          last_target_id: string | null
          page_count: number
          started_at: string
          status: string
          target_kind: string
          updated_at: string
        }
        Insert: {
          captured_on: string
          completed_at?: string | null
          enqueued_count?: number
          expired_at?: string | null
          last_reason_code?: string | null
          last_target_id?: string | null
          page_count?: number
          started_at?: string
          status?: string
          target_kind: string
          updated_at?: string
        }
        Update: {
          captured_on?: string
          completed_at?: string | null
          enqueued_count?: number
          expired_at?: string | null
          last_reason_code?: string | null
          last_target_id?: string | null
          page_count?: number
          started_at?: string
          status?: string
          target_kind?: string
          updated_at?: string
        }
        Relationships: []
      }
      instagram_provider_throttle_buckets: {
        Row: {
          bucket_key: string
          last_reported_at: string | null
          throttled_until: string | null
          updated_at: string
          usage_percent: number | null
        }
        Insert: {
          bucket_key: string
          last_reported_at?: string | null
          throttled_until?: string | null
          updated_at?: string
          usage_percent?: number | null
        }
        Update: {
          bucket_key?: string
          last_reported_at?: string | null
          throttled_until?: string | null
          updated_at?: string
          usage_percent?: number | null
        }
        Relationships: []
      }
      social_contacts: {
        Row: {
          company: string | null
          created_at: string
          display_name: string
          email: string | null
          first_interacted_at: string
          id: string
          identity_kind: string
          last_comment_text: string | null
          last_interacted_at: string
          last_post_id: string | null
          metadata: Json
          notes: string | null
          phone_number: string | null
          platform: string
          platform_user_id: string
          profile_url: string | null
          social_account_id: string | null
          source: string
          tags: string[]
          total_comments_count: number
          updated_at: string
          user_id: string
          username: string | null
          whatsapp_contact_id: string | null
          workspace_id: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string
          display_name?: string
          email?: string | null
          first_interacted_at?: string
          id?: string
          identity_kind?: string
          last_comment_text?: string | null
          last_interacted_at?: string
          last_post_id?: string | null
          metadata?: Json
          notes?: string | null
          phone_number?: string | null
          platform: string
          platform_user_id: string
          profile_url?: string | null
          social_account_id?: string | null
          source?: string
          tags?: string[]
          total_comments_count?: number
          updated_at?: string
          user_id: string
          username?: string | null
          whatsapp_contact_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string
          display_name?: string
          email?: string | null
          first_interacted_at?: string
          id?: string
          identity_kind?: string
          last_comment_text?: string | null
          last_interacted_at?: string
          last_post_id?: string | null
          metadata?: Json
          notes?: string | null
          phone_number?: string | null
          platform?: string
          platform_user_id?: string
          profile_url?: string | null
          social_account_id?: string | null
          source?: string
          tags?: string[]
          total_comments_count?: number
          updated_at?: string
          user_id?: string
          username?: string | null
          whatsapp_contact_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_contacts_social_account_tenant_fk"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "social_contacts_whatsapp_contact_tenant_fk"
            columns: ["whatsapp_contact_id", "user_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "social_contacts_workspace_id_fkey"
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
      store_webhook_heartbeats: {
        Row: {
          connector_id: string
          last_delivery_at: string
          social_account_id: string
          user_id: string
        }
        Insert: {
          connector_id: string
          last_delivery_at: string
          social_account_id: string
          user_id: string
        }
        Update: {
          connector_id?: string
          last_delivery_at?: string
          social_account_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_webhook_heartbeats_connector_fkey"
            columns: ["connector_id", "user_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_tools"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "store_webhook_heartbeats_account_fkey"
            columns: ["social_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
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
          max_media_uploads_per_day: number | null
          max_posts_per_day: number | null
          max_posts_per_month: number | null
          max_social_accounts: number | null
          max_tracked_competitors: number | null
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
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_social_accounts?: number | null
          max_tracked_competitors?: number | null
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
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_social_accounts?: number | null
          max_tracked_competitors?: number | null
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
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_mentions_social_account_id_fkey"
            columns: ["social_account_id"]
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
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_reply_cache_social_account_id_fkey"
            columns: ["social_account_id"]
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
            referencedRelation: "public_social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_refresh_history_account_id_fkey"
            columns: ["account_id"]
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_credits_user_id_fkey"
            columns: ["user_id"]
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_created_by_fkey"
            columns: ["created_by"]
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feature_overrides_user_id_fkey"
            columns: ["user_id"]
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
            referencedRelation: "admin_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      user_quotas: {
        Row: {
          ai_generations_reset_date: string | null
          ai_generations_today: number
          created_at: string | null
          daily_reset_date: string | null
          id: string
          max_ai_generations_per_day: number | null
          max_media_uploads_per_day: number | null
          max_posts_per_day: number | null
          max_posts_per_month: number | null
          max_profiles: number | null
          max_social_accounts: number | null
          max_tracked_competitors: number | null
          media_daily_reset_date: string | null
          media_uploads_today: number | null
          posts_this_month: number | null
          posts_today: number | null
          quota_reset_date: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          ai_generations_reset_date?: string | null
          ai_generations_today?: number
          created_at?: string | null
          daily_reset_date?: string | null
          id?: string
          max_ai_generations_per_day?: number | null
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_profiles?: number | null
          max_social_accounts?: number | null
          max_tracked_competitors?: number | null
          media_daily_reset_date?: string | null
          media_uploads_today?: number | null
          posts_this_month?: number | null
          posts_today?: number | null
          quota_reset_date?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          ai_generations_reset_date?: string | null
          ai_generations_today?: number
          created_at?: string | null
          daily_reset_date?: string | null
          id?: string
          max_ai_generations_per_day?: number | null
          max_media_uploads_per_day?: number | null
          max_posts_per_day?: number | null
          max_posts_per_month?: number | null
          max_profiles?: number | null
          max_social_accounts?: number | null
          max_tracked_competitors?: number | null
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_quotas_user_id_fkey"
            columns: ["user_id"]
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
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_created_by_fkey"
            columns: ["created_by"]
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_rate_limits_user_id_fkey"
            columns: ["user_id"]
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
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
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
      webhook_unmatched_observations: {
        Row: {
          attempts: number
          event_kind: string
          first_seen_at: string
          id: string
          last_seen_at: string
          last_summary: Json
          observed_on: string
          platform: string
          reason: string
          recipient_id: string
          social_account_id: string | null
          user_id: string | null
        }
        Insert: {
          attempts?: number
          event_kind: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          last_summary?: Json
          observed_on?: string
          platform: string
          reason: string
          recipient_id: string
          social_account_id?: string | null
          user_id?: string | null
        }
        Update: {
          attempts?: number
          event_kind?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          last_summary?: Json
          observed_on?: string
          platform?: string
          reason?: string
          recipient_id?: string
          social_account_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_unmatched_observations_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
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
          workspace_id: string | null
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
          workspace_id?: string | null
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
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_assignment_history_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_assignment_history_from_agent_id_fkey"
            columns: ["from_agent_id"]
            referencedRelation: "whatsapp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_assignment_history_to_agent_id_fkey"
            columns: ["to_agent_id"]
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
            referencedRelation: "whatsapp_broadcasts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_broadcast_recipients_contact_id_fkey"
            columns: ["contact_id"]
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
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_contact_group_members_group_id_fkey"
            columns: ["group_id"]
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
            referencedRelation: "messaging_cache"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_agent_id_fkey"
            columns: ["agent_id"]
            referencedRelation: "whatsapp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_conversation_cache_id_fkey"
            columns: ["conversation_cache_id"]
            referencedRelation: "messaging_cache"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_conversation_assignments_workspace_id_fkey"
            columns: ["workspace_id"]
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
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_conversation_workspace_fkey"
            columns: ["conversation_cache_id", "workspace_id"]
            referencedRelation: "messaging_cache"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_pipeline_workspace_fkey"
            columns: ["pipeline_id", "workspace_id"]
            referencedRelation: "whatsapp_pipelines"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_stage_pipeline_workspace_fkey"
            columns: ["stage_id", "pipeline_id", "workspace_id"]
            referencedRelation: "whatsapp_pipeline_stages"
            referencedColumns: ["id", "pipeline_id", "workspace_id"]
          },
          {
            foreignKeyName: "whatsapp_deals_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
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
        Relationships: [
          {
            foreignKeyName: "whatsapp_pipelines_workspace_id_fkey"
            columns: ["workspace_id"]
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
          attempts: number
          claim_token: string | null
          claimed_at: string | null
          created_at: string | null
          error_message: string | null
          id: string
          media_filename: string | null
          media_type: string | null
          media_url: string | null
          message_text: string | null
          recipient_name: string | null
          recipient_phone: string
          scheduled_at: string
          sent_at: string | null
          social_account_id: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          attempts?: number
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
          message_text?: string | null
          recipient_name?: string | null
          recipient_phone: string
          scheduled_at: string
          sent_at?: string | null
          social_account_id: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          attempts?: number
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
          message_text?: string | null
          recipient_name?: string | null
          recipient_phone?: string
          scheduled_at?: string
          sent_at?: string | null
          social_account_id?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_scheduled_messages_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
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
      user_ai_provider_key_status: {
        Row: {
          id: string | null
          user_id: string | null
          provider_code: string | null
          key_hint: string | null
          status: string | null
          last_verified_at: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_ai_provider_keys_provider_code_fkey"
            columns: ["provider_code"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["provider_code"]
          },
        ]
      }
      comment_workflow_rule_stats: {
        Row: {
          dm_sent_count: number | null
          failed_count: number | null
          indeterminate_count: number | null
          last_error_at: string | null
          last_error_message: string | null
          last_triggered_at: string | null
          public_sent_count: number | null
          rule_id: string | null
          triggered_count: number | null
        }
        Relationships: []
      }
      higgsfield_connection_status: {
        Row: {
          account_email: string | null
          connected: boolean | null
          expires_at: string | null
          user_id: string | null
        }
        Insert: {
          account_email?: string | null
          connected?: never
          expires_at?: string | null
          user_id?: string | null
        }
        Update: {
          account_email?: string | null
          connected?: never
          expires_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      hypopg_hidden_indexes: {
        Row: {
          am_name: unknown | null
          index_name: unknown | null
          indexrelid: unknown | null
          is_hypo: boolean | null
          schema_name: unknown | null
          table_name: unknown | null
        }
        Relationships: []
      }
      hypopg_list_indexes: {
        Row: {
          am_name: unknown | null
          index_name: string | null
          indexrelid: unknown | null
          schema_name: unknown | null
          table_name: unknown | null
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
            referencedRelation: "social_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      ai_agent_dashboard: {
        Args: { p_days: number; p_platform?: string | null }
        Returns: Json
      }
      record_store_webhook_delivery: {
        Args: { p_binding_id: string }
        Returns: undefined
      }
      silent_store_connections: {
        Args: { p_quiet_minutes: number; p_active_days: number }
        Returns: Json
      }
      create_ai_website_setup_job: {
        Args: { p_source_id: string; p_social_account_id: string; p_platform: string }
        Returns: string
      }
      partner_write_conversation_assignment: {
        Args: { p_workspace_id: string; p_key_id: string; p_conversation_cache_id: string; p_agent_id: string | null; p_notes: string | null; p_unassign: boolean }
        Returns: Json
      }
      provision_partner_agent: {
        Args: { p_workspace_id: string; p_user_id: string; p_display_name: string; p_max_conversations: number }
        Returns: Json
      }
      website_setup_target_allowed: {
        Args: { p_user: string; p_source: string; p_account: string; p_platform: string }
        Returns: boolean
      }
      read_ai_website_setup: {
        Args: { p_user_id: string; p_social_account_id: string | null; p_platform: string | null; p_job_id?: string | null }
        Returns: Json
      }
      retry_ai_website_setup: {
        Args: { p_user_id: string; p_job_id: string }
        Returns: string
      }
      claim_ai_website_setup: {
        Args: Record<PropertyKey, never>
        Returns: Database["public"]["Tables"]["ai_website_setup_jobs"]["Row"][]
      }
      finish_ai_website_setup: {
        Args: { p_job_id: string; p_lease_token: string; p_result: Json | null; p_error: string | null }
        Returns: boolean
      }
      read_ai_website_setup_input: {
        Args: { p_job_id: string; p_lease_token: string }
        Returns: Json
      }
      apply_ai_website_setup: {
        Args: { p_user_id: string; p_job_id: string; p_expected_updated_at: string | null; p_business_profile: Json; p_agent_behavior: Json; p_business_profile_text: string | null }
        Returns: Json
      }
      accept_workspace_invitation: {
        Args: { p_token: string }
        Returns: string
      }
      media_retention_sweep: {
        Args: { p_now?: string; p_limit?: number }
        Returns: { phase: string; count: number }[]
      }
      media_retention_claim: {
        Args: { p_now?: string; p_limit?: number }
        Returns: {
          media_file_id: string
          user_id: string
          file_type: string
          cloudinary_public_id: string | null
          file_path: string
        }[]
      }
      media_retention_release: {
        Args: { p_id: string; p_user_id: string; p_failed: boolean }
        Returns: undefined
      }
      media_retention_preview: {
        Args: { p_user?: string | null }
        Returns: { media_file_id: string; user_id: string; action: string }[]
      }
      media_set_keep: {
        Args: { p_ids: string[]; p_keep: boolean }
        Returns: number
      }
      add_competitor_watchlist: {
        Args: { p_username: string; p_label?: string | null }
        Returns: Json
      }
      add_ticket_message: {
        Args: {
          p_message: string
          p_is_internal?: boolean
          p_ticket_id: string
          p_attachments?: Json
        }
        Returns: string
      }
      add_user_credits: {
        Args: {
          p_description?: string
          p_stripe_session_id?: string
          p_amount: number
          p_user_id: string
          p_transaction_type?: string
        }
        Returns: number
      }
      admin_get_profiles: {
        Args: { p_offset?: number; p_limit?: number; p_search?: string }
        Returns: {
          email: string
          avatar_url: string
          created_at: string
          referral_code: string
          id: string
          full_name: string
        }[]
      }
      advance_agent_reply: {
        Args: {
          p_id: string
          p_from: string
          p_to: string
          p_generated_reply?: string
          p_error?: string
          p_tool_calls?: Json
        }
        Returns: boolean
      }
      algorithm_sign: {
        Args: { algorithm: string; secret: string; signables: string }
        Returns: string
      }
      assign_ticket: {
        Args: { p_ticket_id: string; p_assignee_id: string }
        Returns: boolean
      }
      begin_meta_account_refresh: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      binary_quantize: {
        Args: { "": string } | { "": unknown }
        Returns: unknown
      }
      calculate_health_score: {
        Args: {
          p_storage_percent: number
          p_edge_function_errors: number
          p_api_error_rate: number
          p_db_query_time: number
        }
        Returns: number
      }
      can_create_post: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      can_upload_media: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      check_rate_limit: {
        Args: {
          p_window_seconds: number
          p_endpoint: string
          p_identifier: string
          p_max_requests: number
        }
        Returns: Json
      }
      claim_agent_replies: {
        Args: {
          p_limit: number
          p_lease_seconds: number
          p_max_attempts: number
        }
        Returns: Database["public"]["Tables"]["pending_agent_replies"]["Row"][]
      }
      claim_ai_knowledge_excel_source: {
        Args: Record<PropertyKey, never>
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
      }
      claim_partner_idempotency: {
        Args: {
          p_key_id: string
          p_idempotency_key: string
          p_lease_seconds?: number
          p_request_hash: string
        }
        Returns: {
          attempt_token: string
          response_body: Json
          http_status: number
          outcome: string
        }[]
      }
      cleanup_expired_otps: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      cleanup_old_health_data: {
        Args: Record<PropertyKey, never>
        Returns: {
          snapshots_deleted: number
          edge_status_deleted: number
          logs_deleted: number
        }[]
      }
      cleanup_old_token_refresh_history: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      cleanup_rate_limit_buckets: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      consume_partner_rate: {
        Args: { p_key_id: string; p_limit: number }
        Returns: boolean
      }
      count_openinary_backfill_remaining: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      create_ai_knowledge_source: {
        Args: {
          p_source_type: string
          p_file_name: string
          p_file_path: string
          p_social_account_ids: string[]
          p_visibility?: string
        }
        Returns: string
      }
      create_default_whatsapp_pipeline: {
        Args: { p_workspace_id: string }
        Returns: string
      }
      create_support_ticket: {
        Args: {
          p_attachments?: Json
          p_priority?: string
          p_category: string
          p_description: string
          p_subject: string
        }
        Returns: string
      }
      effective_competitor_quota: {
        Args: { p_user_id: string }
        Returns: number
      }
      effective_user_quotas: {
        Args: { p_user_id: string }
        Returns: {
          max_profiles: number
          max_social_accounts: number
          max_posts_per_month: number
          max_posts_per_day: number
          max_media_uploads_per_day: number
        }[]
      }
      media_upload_quota_remaining: {
        Args: { p_user: string }
        Returns: number
      }
      enqueue_agent_reply: {
        Args: {
          p_social_account_id: string
          p_platform: string
          p_message_id: string
          p_conversation_id: string
          p_recipient_id: string
          p_inbound_text: string
          p_inbound_at: string
          p_media?: Json
          p_language_hint?: string
          p_comment_id?: string
          p_lease_seconds?: number
        }
        Returns: {
          id: string
          newly_enqueued: boolean
        }[]
      }
      ensure_personal_workspace: {
        Args: { p_user_id: string }
        Returns: string
      }
      generate_referral_code: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_active_ai_model_config: {
        Args: { p_user_id: string; p_feature?: string }
        Returns: {
          supports_streaming: boolean
          provider_code: string
          model_id: string
          model_name: string
          api_endpoint: string
          api_key_env_var: string
          api_type: string
        }[]
      }
      get_cdn_public_config: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      get_cdn_provider_counts: {
        Args: Record<PropertyKey, never>
        Returns: {
          openinary_only: number
          both: number
          cloudinary_only: number
        }[]
      }
      get_checklist_progress: {
        Args: Record<PropertyKey, never>
        Returns: {
          progress_percentage: number
          completed_items: number
          total_items: number
        }[]
      }
      get_coupon_stats: {
        Args: { p_coupon_id: string }
        Returns: {
          unique_users: number
          avg_discount: number
          total_redemptions: number
          total_discount: number
        }[]
      }
      get_cron_jobs: {
        Args: Record<PropertyKey, never>
        Returns: {
          jobid: number
          jobname: string
          schedule: string
          active: boolean
          nodename: string
          nodeport: number
          database: string
          username: string
          command: string
        }[]
      }
      get_cron_secret: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_edge_function_statuses: {
        Args: Record<PropertyKey, never>
        Returns: {
          last_error: string
          function_name: string
          error_rate: number
          avg_execution_time_ms: number
          invocations_last_hour: number
          checked_at: string
          status: string
        }[]
      }
      get_email_stats: {
        Args: { p_days?: number }
        Returns: {
          click_rate: number
          open_rate: number
          delivered_rate: number
          total_sent: number
        }[]
      }
      get_health_history: {
        Args: { p_hours?: number }
        Returns: {
          active_sessions: number
          api_requests_per_minute: number
          health_status: string
          health_score: number
          captured_at: string
        }[]
      }
      get_latest_health_snapshot: {
        Args: Record<PropertyKey, never>
        Returns: {
          health_status: string
          db_connections: number
          api_requests_per_minute: number
          captured_at: string
          health_score: number
          id: string
          total_users: number
          mrr: number
          alerts_active: number
          active_sessions: number
        }[]
      }
      get_my_notifications: {
        Args: { p_unread_only?: boolean; p_limit?: number }
        Returns: {
          expires_at: string
          id: string
          title: string
          message: string
          type: string
          priority: string
          action_label: string
          action_url: string
          published_at: string
          read_at: string
          dismissible: boolean
        }[]
      }
      get_notification_stats: {
        Args: { p_notification_id: string }
        Returns: {
          total_reads: number
          unique_readers: number
          read_rate: number
        }[]
      }
      get_openinary_backfill_batch: {
        Args: { p_retry_failed?: boolean; p_limit: number }
        Returns: {
          object_key: string
          delivery_url: string
          media_file_id: string
          object_version: number
        }[]
      }
      get_system_logs_filtered: {
        Args: {
          p_level?: string
          p_service?: string
          p_hours?: number
          p_limit?: number
        }
        Returns: {
          level: string
          id: string
          created_at: string
          service: string
          component: string
          message: string
          error_code: string
          user_id: string
        }[]
      }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      halfvec_avg: {
        Args: { "": number[] }
        Returns: unknown
      }
      halfvec_out: {
        Args: { "": unknown }
        Returns: unknown
      }
      halfvec_send: {
        Args: { "": unknown }
        Returns: string
      }
      halfvec_typmod_in: {
        Args: { "": unknown[] }
        Returns: number
      }
      get_social_contacts_stats: {
        Args: Record<PropertyKey, never>
        Returns: {
          total: number
          workflow_leads: number
          enriched: number
          top_platform: string
        }[]
      }
      has_role: {
        Args: {
          _user_id: string
          _role: Database["public"]["Enums"]["app_role"]
        }
        Returns: boolean
      }
      hnsw_bit_support: {
        Args: { "": unknown }
        Returns: unknown
      }
      hnsw_halfvec_support: {
        Args: { "": unknown }
        Returns: unknown
      }
      hnsw_sparsevec_support: {
        Args: { "": unknown }
        Returns: unknown
      }
      hnswhandler: {
        Args: { "": unknown }
        Returns: unknown
      }
      hypopg: {
        Args: Record<PropertyKey, never>
        Returns: Record<string, unknown>[]
      }
      hypopg_create_index: {
        Args: { sql_order: string }
        Returns: Record<string, unknown>[]
      }
      hypopg_drop_index: {
        Args: { indexid: unknown }
        Returns: boolean
      }
      hypopg_get_indexdef: {
        Args: { indexid: unknown }
        Returns: string
      }
      hypopg_hidden_indexes: {
        Args: Record<PropertyKey, never>
        Returns: {
          indexid: unknown
        }[]
      }
      hypopg_hide_index: {
        Args: { indexid: unknown }
        Returns: boolean
      }
      hypopg_relation_size: {
        Args: { indexid: unknown }
        Returns: number
      }
      hypopg_reset: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      hypopg_reset_index: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      hypopg_unhide_all_indexes: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      hypopg_unhide_index: {
        Args: { indexid: unknown }
        Returns: boolean
      }
      increment_media_uploads: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      increment_template_use_count: {
        Args: { p_template_id: string }
        Returns: undefined
      }
      index_advisor: {
        Args: { query: string }
        Returns: {
          startup_cost_before: Json
          startup_cost_after: Json
          total_cost_before: Json
          index_statements: string[]
          errors: string[]
          total_cost_after: Json
        }[]
      }
      is_coupon_valid: {
        Args: { p_code: string; p_user_id?: string }
        Returns: boolean
      }
      import_whatsapp_contacts_to_workspace: {
        Args: { p_workspace_id: string; p_rows: Json }
        Returns: { imported_phone: string; outcome: string }[]
      }
      is_workspace_member: {
        Args: { p_user_id?: string; p_workspace_id: string }
        Returns: boolean
      }
      ivfflat_bit_support: {
        Args: { "": unknown }
        Returns: unknown
      }
      ivfflat_halfvec_support: {
        Args: { "": unknown }
        Returns: unknown
      }
      ivfflathandler: {
        Args: { "": unknown }
        Returns: unknown
      }
      l2_norm: {
        Args: { "": unknown } | { "": unknown }
        Returns: number
      }
      l2_normalize: {
        Args: { "": string } | { "": unknown } | { "": unknown }
        Returns: string
      }
      log_admin_action: {
        Args: {
          p_resource_id?: string
          p_resource_type: string
          p_action: string
          p_details?: Json
        }
        Returns: string
      }
      log_email_sent: {
        Args: {
          p_provider_id?: string
          p_recipient_email: string
          p_template_slug: string
          p_subject: string
          p_recipient_id: string
        }
        Returns: string
      }
      log_system_event: {
        Args: {
          p_user_id?: string
          p_error_message?: string
          p_error_code?: string
          p_details?: Json
          p_level: string
          p_service: string
          p_message: string
        }
        Returns: string
      }
      mark_all_notifications_read: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
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
          p_user_id: string
          query_embedding: string
          match_count?: number
        }
        Returns: {
          content: string
          source_id: string
          id: string
          similarity: number
          metadata: Json
        }[]
      }
      match_ai_knowledge_chunks_bge_m3: {
        Args: {
          query_embedding: string
          match_count?: number
          p_user_id: string
        }
        Returns: {
          similarity: number
          metadata: Json
          content: string
          source_id: string
          id: string
        }[]
      }
      match_ai_knowledge_graph_relations: {
        Args: {
          p_user_id: string
          p_source_chunk_ids: string[]
          match_count?: number
        }
        Returns: {
          relation: string
          target_type: string
          source_name: string
          source_type: string
          target_name: string
        }[]
      }
      move_whatsapp_deal: {
        Args: { p_stage_id: string; p_position: number; p_deal_id: string }
        Returns: undefined
      }
      next_media_seq: {
        Args: { p_user_id: string; p_upload_date: string }
        Returns: number
      }
      patch_account_metadata_in_workspace: {
        Args: { p_account_id: string; p_workspace_id: string; p_patch: Json }
        Returns: Json
      }
      instagram_account_capability_projection: {
        Args: { p_social_account_id: string }
        Returns: Json
      }
      read_instagram_account_capability: {
        Args: { p_social_account_id: string; p_user_id: string }
        Returns: Json
      }
      write_direct_instagram_account: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      write_instagram_account_capability: {
        Args: { p_social_account_id: string; p_user_id: string; p_payload: Json }
        Returns: Json
      }
      replace_instagram_account_credential: {
        Args: { p_social_account_id: string; p_user_id: string; p_payload: Json }
        Returns: Json
      }
      record_instagram_account_reconnect: {
        Args: { p_social_account_id: string; p_user_id: string; p_payload: Json }
        Returns: Json
      }
      bump_instagram_credential_generation: {
        Args: { p_social_account_id: string; p_user_id: string; p_reason: string; p_expected_generation: number }
        Returns: Json
      }
      revoke_instagram_account_credential: {
        Args: { p_social_account_id: string; p_user_id: string; p_reason: string; p_expected_generation: number }
        Returns: Json
      }
      read_instagram_account_credential: {
        Args: { p_social_account_id: string; p_user_id: string }
        Returns: Json
      }
      bind_facebook_user_credential: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      write_facebook_user_credential: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      unbind_facebook_user_credential: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      revoke_facebook_user_credential: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      describe_facebook_user_credential: {
        Args: { p_user_id: string; p_credential_id: string }
        Returns: Json
      }
      read_facebook_user_credential: {
        Args: { p_user_id: string; p_credential_id: string }
        Returns: Json
      }
      read_facebook_user_account_credential: {
        Args: { p_user_id: string; p_social_account_id: string }
        Returns: Json
      }
      enqueue_instagram_collection_job: {
        Args: { p_target_kind: string; p_target_id: string; p_mode?: string }
        Returns: Json
      }
      read_instagram_collection_job_status: {
        Args: { p_target_kind: string; p_target_id: string; p_capture_day?: string | null }
        Returns: Json
      }
      enqueue_instagram_collection_jobs_service: {
        Args: { p_owner_id: string; p_requests: Json }
        Returns: Json
      }
      claim_instagram_collection_jobs: {
        Args: { p_target_kind: string; p_limit: number }
        Returns: Json[]
      }
      attach_instagram_collection_job_viewer_context: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_viewer_social_account_id: string
        }
        Returns: Json
      }
      record_instagram_collection_job_progress: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_payload: Json
        }
        Returns: Json
      }
      persist_instagram_collection_snapshot: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_payload: Json
        }
        Returns: Json
      }
      persist_competitor_collection_result: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_payload: Json
        }
        Returns: Json
      }
      persist_competitor_collection_result_v2: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_payload: Json
        }
        Returns: Json
      }
      complete_instagram_collection_job: {
        Args: {
          p_job_id: string
          p_claim_token: string
          p_job_generation: number
          p_outcome: string
          p_reason_code?: string | null
        }
        Returns: Json
      }
      record_instagram_provider_throttle: {
        Args: {
          p_bucket_key: string
          p_usage_percent: number
          p_throttled_until: string
          p_job_id?: string | null
          p_claim_token?: string | null
          p_job_generation?: number | null
        }
        Returns: Json
      }
      read_instagram_collection_job_context: {
        Args: { p_job_id: string; p_claim_token: string }
        Returns: Json
      }
      authorize_instagram_collection_provider_call: {
        Args: { p_job_id: string; p_claim_token: string; p_job_generation: number }
        Returns: Json
      }
      enqueue_instagram_collection_daily_page: {
        Args: { p_target_kind: string; p_start?: boolean }
        Returns: Json
      }
      run_competitor_retention_batch: {
        Args: {
          p_parent_limit: number
          p_child_limit: number
          p_dry_run: boolean
        }
        Returns: Json
      }
      prune_ai_knowledge_entities: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      prune_all_ai_knowledge_entities: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      read_own_competitor_quota: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      read_own_competitor_tracking_report: {
        Args: { p_request: Json }
        Returns: Json
      }
      reap_exhausted_agent_replies: {
        Args: { p_max_attempts: number }
        Returns: Database["public"]["Tables"]["pending_agent_replies"]["Row"][]
      }
      record_meta_refresh_failure: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      redeem_coupon: {
        Args: { p_subscription_id?: string; p_user_id: string; p_code: string }
        Returns: string
      }
      release_ai_generation_quota: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      release_partner_quota: {
        Args: { p_key_id: string }
        Returns: undefined
      }
      render_email_template: {
        Args: { p_slug: string; p_variables: Json }
        Returns: {
          subject: string
          html: string
        }[]
      }
      reserve_ai_generation_quota: {
        Args: { p_user_id: string }
        Returns: {
          daily_limit: number
          usage_count: number
          allowed: boolean
        }[]
      }
      reserve_partner_quota: {
        Args: { p_key_id: string }
        Returns: {
          usage_count: number
          allowed: boolean
        }[]
      }
      resolve_ig_media_post_link: {
        Args: { p_social_account_id: string; p_ig_media_id: string }
        Returns: string
      }
      revoke_partner_key: {
        Args: { p_key_id: string; p_reason: string }
        Returns: boolean
      }
      revoke_connector_connection: {
        Args: { p_connection_id: string }
        Returns: undefined
      }
      create_partner_key: {
        Args: {
          p_workspace_id: string
          p_social_account_id: string
          p_name: string
          p_key_prefix: string
          p_key_hash: string
          p_scopes: string[]
          p_rate_limit_per_min?: number
          p_monthly_quota?: number | null
          p_expires_at?: string | null
          p_request_id?: string | null
          p_environment?: string
        }
        Returns: string
      }
      admin_connector_connections: {
        Args: { p_workspace_id?: string | null }
        Returns: {
          id: string
          workspace_id: string
          workspace_name: string
          connector_type: string
          toolkit: string
          external_account_label: string | null
          status: string
          failure_code: string | null
          dependent_tools: number
          connected_at: string | null
          last_used_at: string | null
          revoked_at: string | null
        }[]
      }
      admin_connector_overview: {
        Args: Record<PropertyKey, never>
        Returns: {
          active_connections: number
          workspaces_with_connections: number
          calls_30d: number
          failures_30d: number
          refused_30d: number
          p95_latency_30d: number | null
        }[]
      }
      admin_connector_usage_by_key: {
        Args: { p_days?: number }
        Returns: {
          partner_key_id: string
          key_name: string | null
          key_prefix: string | null
          workspace_id: string
          workspace_name: string | null
          calls: number
          failures: number
          p95_latency_ms: number | null
        }[]
      }
      admin_connector_usage_by_type: {
        Args: { p_days?: number }
        Returns: {
          connector_type: string
          auth_strategy: string
          calls: number
          failures: number
          p50_latency_ms: number | null
          p95_latency_ms: number | null
        }[]
      }
      admin_partner_key_connector_activity: {
        Args: { p_key_id: string; p_limit?: number }
        Returns: {
          id: string
          created_at: string
          connector_type: string
          action_name: string
          status: string
          error_code: string | null
          latency_ms: number | null
          request_id: string | null
        }[]
      }
      admin_partner_hub_overview: {
        Args: Record<PropertyKey, never>
        Returns: {
          active_keys: number
          revoked_keys: number
          month_billable: number
          month_posts: number
          requests_30d: number
          success_30d: number
          deliveries_30d: number
          delivered_30d: number
          exhausted_30d: number
          pending_deliveries: number
        }[]
      }
      admin_partner_keys: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          name: string
          environment: string
          key_prefix: string
          workspace_id: string
          workspace_name: string | null
          social_account_id: string
          account_platform: string | null
          account_username: string | null
          scopes: string[]
          rate_limit_per_min: number
          monthly_quota: number | null
          usage_charged: number
          usage_reserved: number
          usage_confirmed: number
          usage_indeterminate: number
          period_start: string
          status: string
          created_at: string
          last_used_at: string | null
          expires_at: string | null
          revoked_at: string | null
          revoked_reason: string | null
          superseded_by_key_id: string | null
        }[]
      }
      admin_partner_key_targets: {
        Args: Record<PropertyKey, never>
        Returns: {
          workspace_id: string
          workspace_name: string
          social_account_id: string
          platform: string
          platform_username: string | null
          is_active: boolean
          needs_reauth: boolean
        }[]
      }
      admin_partner_key_activity: {
        Args: { p_key_id: string; p_limit?: number }
        Returns: {
          id: string
          created_at: string
          action: string
          http_status: number
          error_code: string | null
          billable: boolean
          request_id: string | null
          latency_ms: number | null
        }[]
      }
      admin_partner_key_webhook_deliveries: {
        Args: { p_key_id: string; p_limit?: number }
        Returns: {
          id: string
          occurred_at: string
          event_type: string
          status: string
          attempts: number
          next_attempt_at: string
          last_status_code: number | null
          last_error: string | null
          delivered_at: string | null
          webhook_id: string
          webhook_url: string
          webhook_is_active: boolean
        }[]
      }
      list_my_webhook_subscriptions: {
        Args: Record<PropertyKey, never>
        Returns: {
          registry: string
          webhook_id: string
          webhook_url: string
          events: string[]
          platform: string
          social_account_id: string
          is_active: boolean
          failure_count: number
          created_at: string
        }[]
      }
      record_unmatched_webhook_observations: {
        Args: { p_platform: string; p_observations: Json }
        Returns: undefined
      }
      set_ai_knowledge_source_visibility: {
        Args: {
          p_user_id: string
          p_source_id: string
          p_visibility: string
          p_social_account_ids: string[]
        }
        Returns: undefined
      }
      set_user_quotas_for_plan: {
        Args: { p_user_id: string; p_plan_slug: string }
        Returns: undefined
      }
      sign: {
        Args: { secret: string; algorithm?: string; payload: Json }
        Returns: string
      }
      social_account_inbound_activity: {
        Args: Record<PropertyKey, never>
        Returns: {
          social_account_id: string
          last_event_at: string
          events_7d: number
        }[]
      }
      search_social_contacts: {
        Args: {
          p_query: string | null
          p_platform: string | null
          p_source: string | null
          p_tags: string[] | null
          p_limit: number
          p_offset: number
        }
        Returns: {
          row_count: number
          contact: Json
        }[]
      }
      touch_social_contact: {
        Args: {
          p_social_account_id: string
          p_platform: string
          p_author_id: string | null
          p_author_name: string | null
          p_author_username: string | null
          p_comment_text: string | null
          p_post_id: string | null
        }
        Returns: string
      }
      sparsevec_out: {
        Args: { "": unknown }
        Returns: unknown
      }
      sparsevec_send: {
        Args: { "": unknown }
        Returns: string
      }
      sparsevec_typmod_in: {
        Args: { "": unknown[] }
        Returns: number
      }
      toggle_checklist_item: {
        Args: { p_item_id: string; p_completed: boolean }
        Returns: boolean
      }
      toggle_cron_job: {
        Args: { _jobid: number; _active: boolean }
        Returns: undefined
      }
      touch_partner_key: {
        Args: { p_key_id: string }
        Returns: undefined
      }
      try_cast_double: {
        Args: { inp: string }
        Returns: number
      }
      update_competitor_watchlist: {
        Args: { p_watchlist_id: string; p_label?: string | null; p_is_active?: boolean | null }
        Returns: Json
      }
      update_email_status: {
        Args: {
          p_provider_id: string
          p_status: string
          p_error_message?: string
        }
        Returns: boolean
      }
      update_ticket_status: {
        Args: { p_ticket_id: string; p_status: string }
        Returns: boolean
      }
      url_decode: {
        Args: { data: string }
        Returns: string
      }
      url_encode: {
        Args: { data: string }
        Returns: string
      }
      use_credits: {
        Args: { p_user_id: string; p_description?: string; p_amount: number }
        Returns: boolean
      }
      vector_avg: {
        Args: { "": number[] }
        Returns: string
      }
      vector_dims: {
        Args: { "": string } | { "": unknown }
        Returns: number
      }
      vector_norm: {
        Args: { "": string }
        Returns: number
      }
      vector_out: {
        Args: { "": string }
        Returns: unknown
      }
      vector_send: {
        Args: { "": string }
        Returns: string
      }
      vector_typmod_in: {
        Args: { "": unknown[] }
        Returns: number
      }
      verify: {
        Args: { secret: string; algorithm?: string; token: string }
        Returns: {
          payload: Json
          valid: boolean
          header: Json
        }[]
      }
      workspace_connector_usage: {
        Args: { p_workspace_id: string; p_days?: number }
        Returns: {
          tool_id: string
          connector_type: string
          calls: number
          failures: number
          refused: number
          p50_latency_ms: number | null
          last_used_at: string
        }[]
      }
      workspace_role: {
        Args: { p_workspace_id: string; p_user_id?: string }
        Returns: string
      }
      get_whatsapp_account_setup_summary: {
        Args: { p_account_id: string }
        Returns: Json
      }
      get_whatsapp_setup_move_preview: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      list_whatsapp_setup_move_candidates: {
        Args: { p_to: string }
        Returns: Json
      }
      begin_meta_oauth_attempt: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      claim_meta_oauth_callback: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      complete_meta_oauth_callback: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      commit_meta_oauth_selection: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      read_meta_oauth_attempt: {
        Args: { p_user_id: string; p_pending_selection_id: string }
        Returns: Json
      }
      purge_expired_meta_oauth_pending: {
        Args: { p_limit: number }
        Returns: Json
      }
      write_meta_account_refresh_success: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
      }
      write_meta_page_reconciliation_success: {
        Args: { p_user_id: string; p_payload: Json }
        Returns: Json
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

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
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
