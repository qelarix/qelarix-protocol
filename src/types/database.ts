export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          username: string | null
          full_name: string | null
          avatar_url: string | null
          bio: string | null
          plan: 'free' | 'starter' | 'pro' | 'business' | 'ultra'
          credits: number
          credits_used: number
          early_adopter: boolean
          early_adopter_number: number | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string
          subscription_period_end: string | null
          notification_email_generation: boolean
          notification_email_credits: boolean
          notification_email_newsletter: boolean
          api_key_hash: string | null
          api_key_prefix: string | null
          webhook_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          username?: string | null
          full_name?: string | null
          avatar_url?: string | null
          bio?: string | null
          plan?: 'free' | 'starter' | 'pro' | 'business' | 'ultra'
          credits?: number
          credits_used?: number
          early_adopter?: boolean
          early_adopter_number?: number | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          subscription_period_end?: string | null
          notification_email_generation?: boolean
          notification_email_credits?: boolean
          notification_email_newsletter?: boolean
          api_key_hash?: string | null
          api_key_prefix?: string | null
          webhook_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          username?: string | null
          full_name?: string | null
          avatar_url?: string | null
          bio?: string | null
          plan?: 'free' | 'starter' | 'pro' | 'business' | 'ultra'
          credits?: number
          credits_used?: number
          early_adopter?: boolean
          early_adopter_number?: number | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          subscription_period_end?: string | null
          notification_email_generation?: boolean
          notification_email_credits?: boolean
          notification_email_newsletter?: boolean
          api_key_hash?: string | null
          api_key_prefix?: string | null
          webhook_url?: string | null
          updated_at?: string
        }
      }

      generations: {
        Row: {
          id: string
          user_id: string
          type: 'image' | 'video' | 'audio' | 'edit'
          model: string
          prompt: string
          status: string
          output_url: string | null
          thumbnail_url: string | null
          credits_used: number
          settings: Json
          is_public: boolean
          likes: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: 'image' | 'video' | 'audio' | 'edit'
          model: string
          prompt: string
          status?: string
          output_url?: string | null
          thumbnail_url?: string | null
          credits_used: number
          settings?: Json
          is_public?: boolean
          likes?: number
          created_at?: string
        }
        Update: {
          type?: 'image' | 'video' | 'audio' | 'edit'
          model?: string
          prompt?: string
          status?: string
          output_url?: string | null
          thumbnail_url?: string | null
          credits_used?: number
          settings?: Json
          is_public?: boolean
          likes?: number
        }
      }

      credit_transactions: {
        Row: {
          id: string
          user_id: string
          amount: number
          type: 'subscription' | 'topup' | 'bonus' | 'promo' | 'usage' | 'refund'
          description: string | null
          stripe_payment_intent_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          amount: number
          type: 'subscription' | 'topup' | 'bonus' | 'promo' | 'usage' | 'refund'
          description?: string | null
          stripe_payment_intent_id?: string | null
          created_at?: string
        }
        Update: never
      }

      brand_kits: {
        Row: {
          id: string
          user_id: string
          name: string
          logo_url: string | null
          primary_color: string | null
          secondary_color: string | null
          font: string | null
          style_description: string | null
          is_default: boolean
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          logo_url?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          font?: string | null
          style_description?: string | null
          is_default?: boolean
          created_at?: string
        }
        Update: {
          name?: string
          logo_url?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          font?: string | null
          style_description?: string | null
          is_default?: boolean
        }
      }

      characters: {
        Row: {
          id: string
          user_id: string
          name: string
          description: string | null
          reference_images: string[]
          type: 'character' | 'location' | 'prop'
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          description?: string | null
          reference_images?: string[]
          type: 'character' | 'location' | 'prop'
          created_at?: string
        }
        Update: {
          name?: string
          description?: string | null
          reference_images?: string[]
          type?: 'character' | 'location' | 'prop'
        }
      }

      cinema_projects: {
        Row: {
          id: string
          user_id: string
          name: string
          genre: string | null
          style: Json
          scenes: Json
          characters: string[] | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          genre?: string | null
          style?: Json
          scenes?: Json
          characters?: string[] | null
          created_at?: string
        }
        Update: {
          name?: string
          genre?: string | null
          style?: Json
          scenes?: Json
          characters?: string[] | null
        }
      }

      likes: {
        Row: {
          user_id: string
          generation_id: string
        }
        Insert: {
          user_id: string
          generation_id: string
        }
        Update: never
      }

      early_adopter_counter: {
        Row: {
          id: number
          count: number
          max_count: number
        }
        Insert: {
          id?: number
          count?: number
          max_count?: number
        }
        Update: {
          count?: number
          max_count?: number
        }
      }
    }

    Views: Record<string, never>

    Functions: {
      deduct_credits: {
        Args: {
          p_user_id: string
          p_amount: number
          p_desc: string
        }
        Returns: boolean
      }
      add_credits: {
        Args: {
          p_user_id: string
          p_amount: number
          p_type: string
          p_desc: string
          p_stripe_payment_intent_id?: string
        }
        Returns: void
      }
      provision_nextauth_profile: {
        Args: {
          p_user_id: string
          p_full_name?: string
          p_avatar?: string
        }
        Returns: Json
      }
    }

    Enums: Record<string, never>
  }
}

// Convenience type aliases
export type Profile = Database['public']['Tables']['profiles']['Row']
export type ProfileInsert = Database['public']['Tables']['profiles']['Insert']
export type ProfileUpdate = Database['public']['Tables']['profiles']['Update']

export type Generation = Database['public']['Tables']['generations']['Row']
export type GenerationInsert = Database['public']['Tables']['generations']['Insert']
export type GenerationUpdate = Database['public']['Tables']['generations']['Update']

export type CreditTransaction = Database['public']['Tables']['credit_transactions']['Row']
export type CreditTransactionInsert = Database['public']['Tables']['credit_transactions']['Insert']

export type BrandKit = Database['public']['Tables']['brand_kits']['Row']
export type BrandKitInsert = Database['public']['Tables']['brand_kits']['Insert']
export type BrandKitUpdate = Database['public']['Tables']['brand_kits']['Update']

export type Character = Database['public']['Tables']['characters']['Row']
export type CharacterInsert = Database['public']['Tables']['characters']['Insert']
export type CharacterUpdate = Database['public']['Tables']['characters']['Update']

export type CinemaProject = Database['public']['Tables']['cinema_projects']['Row']
export type CinemaProjectInsert = Database['public']['Tables']['cinema_projects']['Insert']
export type CinemaProjectUpdate = Database['public']['Tables']['cinema_projects']['Update']

export type Like = Database['public']['Tables']['likes']['Row']

export type Plan = Profile['plan']
export type GenerationType = Generation['type']
export type CreditTransactionType = CreditTransaction['type']
export type CharacterType = Character['type']
