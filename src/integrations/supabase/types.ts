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
      app_config: {
        Row: {
          fee_bps: number
          final_stretch_threshold: number
          id: number
          quote_stale_seconds: number
          starting_balance_usd: number
          updated_at: string
        }
        Insert: {
          fee_bps?: number
          final_stretch_threshold?: number
          id?: number
          quote_stale_seconds?: number
          starting_balance_usd?: number
          updated_at?: string
        }
        Update: {
          fee_bps?: number
          final_stretch_threshold?: number
          id?: number
          quote_stale_seconds?: number
          starting_balance_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      markets: {
        Row: {
          address: string
          chain: string
          circulating_supply: number | null
          curve_progress: number | null
          id: string
          image_uri: string | null
          kind: string
          launched_at: string | null
          liquidity_usd: number | null
          migrated_from: string | null
          migrated_to: string | null
          mint: string
          name: string | null
          price_quote: number | null
          quote_ccy: string
          quote_model: string | null
          reserve_base: number | null
          reserve_quote: number | null
          stage: string
          state_source: string | null
          state_updated_at: string | null
          status: string
          symbol: string | null
          total_supply: number | null
          trade_feed: string
          updated_at: string
          venue: string
        }
        Insert: {
          address: string
          chain: string
          circulating_supply?: number | null
          curve_progress?: number | null
          id: string
          image_uri?: string | null
          kind: string
          launched_at?: string | null
          liquidity_usd?: number | null
          migrated_from?: string | null
          migrated_to?: string | null
          mint: string
          name?: string | null
          price_quote?: number | null
          quote_ccy: string
          quote_model?: string | null
          reserve_base?: number | null
          reserve_quote?: number | null
          stage?: string
          state_source?: string | null
          state_updated_at?: string | null
          status?: string
          symbol?: string | null
          total_supply?: number | null
          trade_feed?: string
          updated_at?: string
          venue: string
        }
        Update: {
          address?: string
          chain?: string
          circulating_supply?: number | null
          curve_progress?: number | null
          id?: string
          image_uri?: string | null
          kind?: string
          launched_at?: string | null
          liquidity_usd?: number | null
          migrated_from?: string | null
          migrated_to?: string | null
          mint?: string
          name?: string | null
          price_quote?: number | null
          quote_ccy?: string
          quote_model?: string | null
          reserve_base?: number | null
          reserve_quote?: number | null
          stage?: string
          state_source?: string | null
          state_updated_at?: string | null
          status?: string
          symbol?: string | null
          total_supply?: number | null
          trade_feed?: string
          updated_at?: string
          venue?: string
        }
        Relationships: []
      }
      paper_accounts: {
        Row: {
          cash_usd: number
          created_at: string
          reserved_cash_usd: number
          reset_at: string | null
          starting_balance_usd: number
          user_id: string
        }
        Insert: {
          cash_usd?: number
          created_at?: string
          reserved_cash_usd?: number
          reset_at?: string | null
          starting_balance_usd: number
          user_id: string
        }
        Update: {
          cash_usd?: number
          created_at?: string
          reserved_cash_usd?: number
          reset_at?: string | null
          starting_balance_usd?: number
          user_id?: string
        }
        Relationships: []
      }
      paper_fills: {
        Row: {
          created_at: string
          fee_usd: number
          id: string
          market_id: string
          market_state_at: string
          mint: string
          notional_usd: number
          order_id: string
          price_impact_bps: number
          price_quote: number
          price_usd: number
          qty: number
          quote_ccy: string
          quote_usd_rate: number
          realized_pnl_usd: number | null
          side: string
          symbol: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          fee_usd: number
          id?: string
          market_id: string
          market_state_at: string
          mint: string
          notional_usd: number
          order_id: string
          price_impact_bps: number
          price_quote: number
          price_usd: number
          qty: number
          quote_ccy: string
          quote_usd_rate: number
          realized_pnl_usd?: number | null
          side: string
          symbol?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          fee_usd?: number
          id?: string
          market_id?: string
          market_state_at?: string
          mint?: string
          notional_usd?: number
          order_id?: string
          price_impact_bps?: number
          price_quote?: number
          price_usd?: number
          qty?: number
          quote_ccy?: string
          quote_usd_rate?: number
          realized_pnl_usd?: number | null
          side?: string
          symbol?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_fills_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "paper_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_ledger: {
        Row: {
          cash_delta_usd: number
          created_at: string
          id: number
          kind: string
          mint: string | null
          note: string | null
          order_id: string | null
          qty_delta: number
          user_id: string
        }
        Insert: {
          cash_delta_usd?: number
          created_at?: string
          id?: number
          kind: string
          mint?: string | null
          note?: string | null
          order_id?: string | null
          qty_delta?: number
          user_id: string
        }
        Update: {
          cash_delta_usd?: number
          created_at?: string
          id?: number
          kind?: string
          mint?: string | null
          note?: string | null
          order_id?: string | null
          qty_delta?: number
          user_id?: string
        }
        Relationships: []
      }
      paper_orders: {
        Row: {
          amount: number
          chain: string
          created_at: string
          expected_price_usd: number | null
          id: string
          idempotency_key: string
          limit_price_usd: number | null
          market_id: string
          mint: string
          order_type: string
          reject_reason: string | null
          side: string
          slippage_bps: number
          status: string
          symbol: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          chain: string
          created_at?: string
          expected_price_usd?: number | null
          id?: string
          idempotency_key: string
          limit_price_usd?: number | null
          market_id: string
          mint: string
          order_type: string
          reject_reason?: string | null
          side: string
          slippage_bps: number
          status: string
          symbol?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          chain?: string
          created_at?: string
          expected_price_usd?: number | null
          id?: string
          idempotency_key?: string
          limit_price_usd?: number | null
          market_id?: string
          mint?: string
          order_type?: string
          reject_reason?: string | null
          side?: string
          slippage_bps?: number
          status?: string
          symbol?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          chain: string
          cost_basis_usd: number
          fees_usd: number
          last_market_id: string | null
          mint: string
          qty: number
          realized_pnl_usd: number
          reserved_qty: number
          symbol: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          chain: string
          cost_basis_usd?: number
          fees_usd?: number
          last_market_id?: string | null
          mint: string
          qty?: number
          realized_pnl_usd?: number
          reserved_qty?: number
          symbol?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          chain?: string
          cost_basis_usd?: number
          fees_usd?: number
          last_market_id?: string | null
          mint?: string
          qty?: number
          realized_pnl_usd?: number
          reserved_qty?: number
          symbol?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reference_prices: {
        Row: {
          pair: string
          price: number
          source: string
          updated_at: string
        }
        Insert: {
          pair: string
          price: number
          source: string
          updated_at: string
        }
        Update: {
          pair?: string
          price?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          buy_presets_usd: number[]
          default_slippage_bps: number
          prefs: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          buy_presets_usd?: number[]
          default_slippage_bps?: number
          prefs?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          buy_presets_usd?: number[]
          default_slippage_bps?: number
          prefs?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      watchlist: {
        Row: {
          created_at: string
          market_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          market_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          market_id?: string
          user_id?: string
        }
        Relationships: []
      }
      worker_status: {
        Row: {
          coverage: Json
          id: string
          last_heartbeat_at: string
          public_url: string | null
          stats: Json
          status: string
        }
        Insert: {
          coverage?: Json
          id: string
          last_heartbeat_at?: string
          public_url?: string | null
          stats?: Json
          status?: string
        }
        Update: {
          coverage?: Json
          id?: string
          last_heartbeat_at?: string
          public_url?: string | null
          stats?: Json
          status?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ensure_paper_account: { Args: { _uid: string }; Returns: undefined }
      my_paper_account: {
        Args: never
        Returns: {
          cash_usd: number
          created_at: string
          reserved_cash_usd: number
          reset_at: string | null
          starting_balance_usd: number
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "paper_accounts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      place_market_order: {
        Args: {
          p_amount: number
          p_expected_price_usd: number
          p_idempotency_key: string
          p_market_id: string
          p_side: string
          p_slippage_bps: number
        }
        Returns: Json
      }
      reset_paper_account: { Args: never; Returns: Json }
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
