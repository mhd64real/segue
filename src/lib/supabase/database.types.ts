export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_state: {
        Row: {
          google_email: string | null
          history_id: string | null
          id: boolean
          last_checked_at: string | null
          last_error: string | null
          llm_paused_reason: string | null
          needs_reauth: boolean
          refresh_token_enc: string | null
          updated_at: string
          watch_expires_at: string | null
        }
        Insert: {
          google_email?: string | null
          history_id?: string | null
          id?: boolean
          last_checked_at?: string | null
          last_error?: string | null
          llm_paused_reason?: string | null
          needs_reauth?: boolean
          refresh_token_enc?: string | null
          updated_at?: string
          watch_expires_at?: string | null
        }
        Update: {
          google_email?: string | null
          history_id?: string | null
          id?: boolean
          last_checked_at?: string | null
          last_error?: string | null
          llm_paused_reason?: string | null
          needs_reauth?: boolean
          refresh_token_enc?: string | null
          updated_at?: string
          watch_expires_at?: string | null
        }
        Relationships: []
      }
      branches: {
        Row: {
          base_script: string
          created_at: string
          decided_at: string | null
          id: string
          script: string
          segment_summary: string
          sponsorship_id: string
          status: Database["public"]["Enums"]["branch_status"]
          updated_at: string
          video_id: string
        }
        Insert: {
          base_script: string
          created_at?: string
          decided_at?: string | null
          id?: string
          script: string
          segment_summary: string
          sponsorship_id: string
          status?: Database["public"]["Enums"]["branch_status"]
          updated_at?: string
          video_id: string
        }
        Update: {
          base_script?: string
          created_at?: string
          decided_at?: string | null
          id?: string
          script?: string
          segment_summary?: string
          sponsorship_id?: string
          status?: Database["public"]["Enums"]["branch_status"]
          updated_at?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_sponsorship_id_fkey"
            columns: ["sponsorship_id"]
            isOneToOne: true
            referencedRelation: "sponsorships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branches_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["id"]
          },
        ]
      }
      email_drafts: {
        Row: {
          based_on: string
          body: string | null
          branch_id: string
          cc: string[]
          created_at: string
          error: string | null
          gmail_message_id: string | null
          id: string
          kind: Database["public"]["Enums"]["email_draft_kind"]
          request_id: string
          sending_started_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["email_draft_status"]
          subject: string | null
          to_email: string | null
          updated_at: string
        }
        Insert: {
          based_on: string
          body?: string | null
          branch_id: string
          cc?: string[]
          created_at?: string
          error?: string | null
          gmail_message_id?: string | null
          id?: string
          kind: Database["public"]["Enums"]["email_draft_kind"]
          request_id: string
          sending_started_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_draft_status"]
          subject?: string | null
          to_email?: string | null
          updated_at?: string
        }
        Update: {
          based_on?: string
          body?: string | null
          branch_id?: string
          cc?: string[]
          created_at?: string
          error?: string | null
          gmail_message_id?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["email_draft_kind"]
          request_id?: string
          sending_started_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_draft_status"]
          subject?: string | null
          to_email?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_drafts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_messages: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          gmail_message_id: string
          input_tokens: number
          lease_expires_at: string | null
          output_tokens: number
          status: Database["public"]["Enums"]["inbox_message_status"]
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          gmail_message_id: string
          input_tokens?: number
          lease_expires_at?: string | null
          output_tokens?: number
          status?: Database["public"]["Enums"]["inbox_message_status"]
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          gmail_message_id?: string
          input_tokens?: number
          lease_expires_at?: string | null
          output_tokens?: number
          status?: Database["public"]["Enums"]["inbox_message_status"]
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          read_at: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          read_at?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          read_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      sponsorships: {
        Row: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }
        Insert: {
          attempts?: number
          body_text: string
          brand?: string | null
          cc?: string[]
          compensation?: string | null
          created_at?: string
          deadline?: string | null
          deliverable?: string | null
          error?: string | null
          fit_reason?: string | null
          from_email: string
          from_name?: string | null
          gmail_message_id: string
          id?: string
          input_tokens?: number
          last_reply_at?: string | null
          lease_expires_at?: string | null
          output_tokens?: number
          product?: string | null
          received_at: string
          reply_to?: string | null
          status?: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary?: string | null
          thread_id: string
          updated_at?: string
          video_id?: string | null
        }
        Update: {
          attempts?: number
          body_text?: string
          brand?: string | null
          cc?: string[]
          compensation?: string | null
          created_at?: string
          deadline?: string | null
          deliverable?: string | null
          error?: string | null
          fit_reason?: string | null
          from_email?: string
          from_name?: string | null
          gmail_message_id?: string
          id?: string
          input_tokens?: number
          last_reply_at?: string | null
          lease_expires_at?: string | null
          output_tokens?: number
          product?: string | null
          received_at?: string
          reply_to?: string | null
          status?: Database["public"]["Enums"]["sponsorship_status"]
          subject?: string
          summary?: string | null
          thread_id?: string
          updated_at?: string
          video_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sponsorships_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["id"]
          },
        ]
      }
      videos: {
        Row: {
          created_at: string
          id: string
          monitoring: boolean
          script: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          monitoring?: boolean
          script?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          monitoring?: boolean
          script?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      advance_history_id: { Args: { p_history_id: string }; Returns: boolean }
      claim_draft_send: {
        Args: { p_draft_id: string }
        Returns: {
          based_on: string
          body: string | null
          branch_id: string
          cc: string[]
          created_at: string
          error: string | null
          gmail_message_id: string | null
          id: string
          kind: Database["public"]["Enums"]["email_draft_kind"]
          request_id: string
          sending_started_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["email_draft_status"]
          subject: string | null
          to_email: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "email_drafts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_inbox_message: {
        Args: {
          p_gmail_message_id?: string
          p_lease_seconds: number
          p_max_attempts: number
        }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          gmail_message_id: string
          input_tokens: number
          lease_expires_at: string | null
          output_tokens: number
          status: Database["public"]["Enums"]["inbox_message_status"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "inbox_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_sponsorship: {
        Args: {
          p_id?: string
          p_lease_seconds: number
          p_max_attempts: number
          p_statuses: Database["public"]["Enums"]["sponsorship_status"][]
        }
        Returns: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "sponsorships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      decide_branch: {
        Args: {
          p_branch_id: string
          p_status: Database["public"]["Enums"]["branch_status"]
        }
        Returns: {
          based_on: string
          body: string | null
          branch_id: string
          cc: string[]
          created_at: string
          error: string | null
          gmail_message_id: string | null
          id: string
          kind: Database["public"]["Enums"]["email_draft_kind"]
          request_id: string
          sending_started_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["email_draft_status"]
          subject: string | null
          to_email: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "email_drafts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      delete_video: { Args: { p_video_id: string }; Returns: string }
      reclaim_expired_leases: {
        Args: { p_error: string; p_max_attempts: number }
        Returns: {
          inbox_failed: number
          inbox_released: number
          sponsorships_failed: number
          sponsorships_released: number
        }[]
      }
      record_sponsor_reply: {
        Args: { p_replied_at: string; p_thread_id: string }
        Returns: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "sponsorships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      release_inbox_message: {
        Args: {
          p_error?: string
          p_gmail_message_id: string
          p_input_tokens?: number
          p_max_attempts: number
          p_output_tokens?: number
          p_refund_attempt: boolean
        }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          gmail_message_id: string
          input_tokens: number
          lease_expires_at: string | null
          output_tokens: number
          status: Database["public"]["Enums"]["inbox_message_status"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "inbox_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      release_sponsorship: {
        Args: {
          p_error?: string
          p_id: string
          p_input_tokens?: number
          p_max_attempts: number
          p_output_tokens?: number
          p_refund_attempt: boolean
        }
        Returns: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "sponsorships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      retry_sponsorship: {
        Args: { p_id: string }
        Returns: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "sponsorships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      settle_inbox_message: {
        Args: {
          p_error?: string
          p_gmail_message_id: string
          p_input_tokens?: number
          p_output_tokens?: number
          p_status: Database["public"]["Enums"]["inbox_message_status"]
        }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          gmail_message_id: string
          input_tokens: number
          lease_expires_at: string | null
          output_tokens: number
          status: Database["public"]["Enums"]["inbox_message_status"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "inbox_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      settle_sponsorship: {
        Args: {
          p_error?: string
          p_fit_reason?: string
          p_from: Database["public"]["Enums"]["sponsorship_status"]
          p_id: string
          p_input_tokens?: number
          p_output_tokens?: number
          p_to: Database["public"]["Enums"]["sponsorship_status"]
          p_video_id?: string
        }
        Returns: {
          attempts: number
          body_text: string
          brand: string | null
          cc: string[]
          compensation: string | null
          created_at: string
          deadline: string | null
          deliverable: string | null
          error: string | null
          fit_reason: string | null
          from_email: string
          from_name: string | null
          gmail_message_id: string
          id: string
          input_tokens: number
          last_reply_at: string | null
          lease_expires_at: string | null
          output_tokens: number
          product: string | null
          received_at: string
          reply_to: string | null
          status: Database["public"]["Enums"]["sponsorship_status"]
          subject: string
          summary: string | null
          thread_id: string
          updated_at: string
          video_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "sponsorships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_branch_script: {
        Args: { p_branch_id: string; p_script: string }
        Returns: {
          base_script: string
          created_at: string
          decided_at: string | null
          id: string
          script: string
          segment_summary: string
          sponsorship_id: string
          status: Database["public"]["Enums"]["branch_status"]
          updated_at: string
          video_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "branches"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      branch_status: "pending" | "approved" | "rejected"
      email_draft_kind: "accept" | "decline"
      email_draft_status: "generating" | "draft" | "failed" | "sending" | "sent"
      inbox_message_status:
        | "pending"
        | "not_sponsorship"
        | "followup"
        | "sponsorship"
        | "skipped"
        | "failed"
      sponsorship_status:
        | "matching"
        | "writing"
        | "branched"
        | "no_fit"
        | "failed"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      branch_status: ["pending", "approved", "rejected"],
      email_draft_kind: ["accept", "decline"],
      email_draft_status: ["generating", "draft", "failed", "sending", "sent"],
      inbox_message_status: [
        "pending",
        "not_sponsorship",
        "followup",
        "sponsorship",
        "skipped",
        "failed",
      ],
      sponsorship_status: [
        "matching",
        "writing",
        "branched",
        "no_fit",
        "failed",
      ],
    },
  },
} as const
