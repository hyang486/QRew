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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      arrivals: {
        Row: {
          activity_seq: number
          arrived_at: string
          room_id: string
          user_id: string
        }
        Insert: {
          activity_seq?: number
          arrived_at?: string
          room_id: string
          user_id: string
        }
        Update: {
          activity_seq?: number
          arrived_at?: string
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "arrivals_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      cleanup_jobs: {
        Row: {
          attempts: number
          bucket: string
          created_at: string
          id: string
          last_error: string | null
          prefix: string
          reason: string
          verified_empty_at: string | null
        }
        Insert: {
          attempts?: number
          bucket: string
          created_at?: string
          id?: string
          last_error?: string | null
          prefix: string
          reason: string
          verified_empty_at?: string | null
        }
        Update: {
          attempts?: number
          bucket?: string
          created_at?: string
          id?: string
          last_error?: string | null
          prefix?: string
          reason?: string
          verified_empty_at?: string | null
        }
        Relationships: []
      }
      emergency_acks: {
        Row: {
          acked_at: string
          event_id: string
          user_id: string
        }
        Insert: {
          acked_at?: string
          event_id: string
          user_id: string
        }
        Update: {
          acked_at?: string
          event_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emergency_acks_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "emergency_events"
            referencedColumns: ["id"]
          },
        ]
      }
      emergency_events: {
        Row: {
          created_at: string
          id: string
          push_requested_at: string | null
          push_result: Json | null
          room_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          push_requested_at?: string | null
          push_result?: Json | null
          room_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          push_requested_at?: string | null
          push_result?: Json | null
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emergency_events_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      expiry_reminders: {
        Row: {
          created_at: string
          detail: Json | null
          expiry_version: number
          room_id: string
          sent_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          expiry_version: number
          room_id: string
          sent_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json | null
          expiry_version?: number
          room_id?: string
          sent_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expiry_reminders_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      face_enrollments: {
        Row: {
          created_at: string
          id: string
          ref_path: string
          room_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          ref_path: string
          room_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          ref_path?: string
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "face_enrollments_room_id_user_id_fkey"
            columns: ["room_id", "user_id"]
            isOneToOne: true
            referencedRelation: "room_members"
            referencedColumns: ["room_id", "user_id"]
          },
        ]
      }
      face_jobs: {
        Row: {
          attempts: number
          created_at: string
          enrollment_id: string
          id: string
          last_error: string | null
          media_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          enrollment_id: string
          id?: string
          last_error?: string | null
          media_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          enrollment_id?: string
          id?: string
          last_error?: string | null
          media_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "face_jobs_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "face_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_jobs_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      face_matches: {
        Row: {
          created_at: string
          enrollment_id: string
          excluded: boolean
          matched: boolean
          media_id: string
          similarity: number | null
        }
        Insert: {
          created_at?: string
          enrollment_id: string
          excluded?: boolean
          matched: boolean
          media_id: string
          similarity?: number | null
        }
        Update: {
          created_at?: string
          enrollment_id?: string
          excluded?: boolean
          matched?: boolean
          media_id?: string
          similarity?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "face_matches_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "face_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_matches_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      join_attempts: {
        Row: {
          attempted_at: string
          id: number
          succeeded: boolean
          user_id: string
        }
        Insert: {
          attempted_at?: string
          id?: never
          succeeded: boolean
          user_id: string
        }
        Update: {
          attempted_at?: string
          id?: never
          succeeded?: boolean
          user_id?: string
        }
        Relationships: []
      }
      live_presence: {
        Row: {
          accuracy_m: number | null
          heading: number | null
          lat: number
          lng: number
          room_id: string
          speed_mps: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          accuracy_m?: number | null
          heading?: number | null
          lat: number
          lng: number
          room_id: string
          speed_mps?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          accuracy_m?: number | null
          heading?: number | null
          lat?: number
          lng?: number
          room_id?: string
          speed_mps?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_presence_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      media: {
        Row: {
          created_at: string
          content_sha256: string | null
          duration_ms: number | null
          file_name: string
          height: number | null
          id: string
          kind: string
          mime_type: string
          original_path: string
          preview_path: string | null
          room_id: string
          size_bytes: number | null
          status: string
          uploader_id: string
          width: number | null
        }
        Insert: {
          created_at?: string
          content_sha256?: string | null
          duration_ms?: number | null
          file_name: string
          height?: number | null
          id?: string
          kind: string
          mime_type: string
          original_path: string
          preview_path?: string | null
          room_id: string
          size_bytes?: number | null
          status?: string
          uploader_id: string
          width?: number | null
        }
        Update: {
          created_at?: string
          content_sha256?: string | null
          duration_ms?: number | null
          file_name?: string
          height?: number | null
          id?: string
          kind?: string
          mime_type?: string
          original_path?: string
          preview_path?: string | null
          room_id?: string
          size_bytes?: number | null
          status?: string
          uploader_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      member_status: {
        Row: {
          room_id: string
          status_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          room_id: string
          status_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          room_id?: string
          status_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_status_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_status_status_id_fkey"
            columns: ["status_id"]
            isOneToOne: false
            referencedRelation: "status_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          media_id: string | null
          room_id: string
          sender_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          media_id?: string | null
          room_id: string
          sender_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          media_id?: string | null
          room_id?: string
          sender_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      push_tokens: {
        Row: {
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          platform?: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      room_members: {
        Row: {
          joined_at: string
          role: string
          room_id: string
          share_location: boolean
          user_id: string
        }
        Insert: {
          joined_at?: string
          role?: string
          room_id: string
          share_location?: boolean
          user_id: string
        }
        Update: {
          joined_at?: string
          role?: string
          room_id?: string
          share_location?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          activity_ended_at: string | null
          activity_seq: number
          activity_started_at: string | null
          activity_state: string
          code: string
          created_at: string
          deleted_at: string | null
          expires_at: string
          expiry_version: number
          host_id: string
          id: string
          invite_token: string
          location_allowed: boolean
          max_members: number
          name: string
          route: Json
          type: string
        }
        Insert: {
          activity_ended_at?: string | null
          activity_seq?: number
          activity_started_at?: string | null
          activity_state?: string
          code: string
          created_at?: string
          deleted_at?: string | null
          expires_at: string
          expiry_version?: number
          host_id: string
          id?: string
          invite_token?: string
          location_allowed?: boolean
          max_members?: number
          name: string
          route?: Json
          type?: string
        }
        Update: {
          activity_ended_at?: string | null
          activity_seq?: number
          activity_started_at?: string | null
          activity_state?: string
          code?: string
          created_at?: string
          deleted_at?: string | null
          expires_at?: string
          expiry_version?: number
          host_id?: string
          id?: string
          invite_token?: string
          location_allowed?: boolean
          max_members?: number
          name?: string
          route?: Json
          type?: string
        }
        Relationships: []
      }
      status_definitions: {
        Row: {
          id: string
          is_emergency: boolean
          label: string
          room_id: string
          sort: number
        }
        Insert: {
          id?: string
          is_emergency?: boolean
          label: string
          room_id: string
          sort?: number
        }
        Update: {
          id?: string
          is_emergency?: boolean
          label?: string
          room_id?: string
          sort?: number
        }
        Relationships: [
          {
            foreignKeyName: "status_definitions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_emergency: { Args: { p_event_id: string }; Returns: undefined }
      clear_my_status: { Args: { p_room_id: string }; Returns: undefined }
      create_room: {
        Args: {
          p_expires_at: string
          p_location_allowed: boolean
          p_name: string
          p_statuses?: string[]
          p_type: string
        }
        Returns: {
          activity_ended_at: string | null
          activity_seq: number
          activity_started_at: string | null
          activity_state: string
          code: string
          created_at: string
          deleted_at: string | null
          expires_at: string
          expiry_version: number
          host_id: string
          id: string
          invite_token: string
          location_allowed: boolean
          max_members: number
          name: string
          route: Json
          type: string
        }
        SetofOptions: {
          from: "*"
          to: "rooms"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      end_room: { Args: { p_room_id: string }; Returns: undefined }
      enroll_face: {
        Args: { p_ref_path: string; p_room_id: string }
        Returns: string
      }
      join_room: {
        Args: { p_code?: string; p_token?: string }
        Returns: string
      }
      leave_room: { Args: { p_room_id: string }; Returns: undefined }
      mark_arrived: { Args: { p_room_id: string }; Returns: string }
      preview_room: {
        Args: { p_code?: string; p_token?: string }
        Returns: {
          already_member: boolean
          expires_at: string
          max_members: number
          member_count: number
          name: string
          room_id: string
          type: string
        }[]
      }
      register_push_token: {
        Args: { p_platform?: string; p_token: string }
        Returns: undefined
      }
      remove_face_enrollment: {
        Args: { p_room_id: string }
        Returns: undefined
      }
      report_location: {
        Args: {
          p_accuracy?: number
          p_heading?: number
          p_lat: number
          p_lng: number
          p_room_id: string
          p_speed?: number
        }
        Returns: boolean
      }
      rotate_invite: {
        Args: { p_room_id: string }
        Returns: {
          code: string
          invite_token: string
        }[]
      }
      set_activity_state: {
        Args: { p_room_id: string; p_state: string }
        Returns: undefined
      }
      set_location_allowed: {
        Args: { p_allowed: boolean; p_room_id: string }
        Returns: undefined
      }
      set_my_status: {
        Args: { p_room_id: string; p_status_id: string }
        Returns: string
      }
      set_route: {
        Args: { p_room_id: string; p_route: Json }
        Returns: undefined
      }
      set_share_location: {
        Args: { p_room_id: string; p_share: boolean }
        Returns: undefined
      }
      set_status_definitions: {
        Args: { p_labels: string[]; p_room_id: string }
        Returns: undefined
      }
      stop_my_location: { Args: never; Returns: undefined }
      unregister_push_token: { Args: { p_token: string }; Returns: undefined }
      update_room_expiry: {
        Args: { p_expires_at: string; p_room_id: string }
        Returns: {
          activity_ended_at: string | null
          activity_seq: number
          activity_started_at: string | null
          activity_state: string
          code: string
          created_at: string
          deleted_at: string | null
          expires_at: string
          expiry_version: number
          host_id: string
          id: string
          invite_token: string
          location_allowed: boolean
          max_members: number
          name: string
          route: Json
          type: string
        }
        SetofOptions: {
          from: "*"
          to: "rooms"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
