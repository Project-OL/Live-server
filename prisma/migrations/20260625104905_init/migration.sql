-- CreateEnum
CREATE TYPE "public"."StoreItemCategory" AS ENUM ('RIDE', 'AVATAR_FRAME', 'CHAT_BUBBLE', 'PROFILE_CARD');

-- CreateEnum
CREATE TYPE "public"."CreatorSubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."GuardianTier" AS ENUM ('SILVER', 'GOLD', 'KING');

-- CreateEnum
CREATE TYPE "public"."PostVisibility" AS ENUM ('PUBLIC', 'SUBSCRIBERS_ONLY');

-- CreateEnum
CREATE TYPE "public"."PostMediaType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "public"."ConversationType" AS ENUM ('DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "public"."MessageType" AS ENUM ('TEXT', 'TEXT_COINS', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "public"."MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'FILE');

-- CreateEnum
CREATE TYPE "public"."MediaProcessingStatus" AS ENUM ('NONE', 'PENDING', 'ENQUEUED', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."MediaTranscriptionStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'FAKE_ACCOUNT', 'VIOLENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "public"."WalletCurrencyType" AS ENUM ('COIN', 'POINT', 'TRADING_COIN');

-- CreateEnum
CREATE TYPE "public"."LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "public"."CoinTxType" AS ENUM ('TOPUP', 'TRADING_TOPUP', 'GIFT_SEND', 'GIFT_REFUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'TRADING_TRANSFER_OUT', 'TRADING_TRANSFER_IN', 'TRADING_EXCHANGE_FROM_POINTS', 'TRADING_TRANSFER_REVERSAL', 'VIP_PURCHASE', 'VIP_REWARD', 'DAILY_LOGIN', 'WEEKLY_TOPUP', 'PLATFORM_REWARD', 'EXPIRE', 'ADJUSTMENT', 'VIDEO_CALL', 'USERNAME_CHANGE', 'CREATOR_SUBSCRIPTION', 'GUARDIAN_PURCHASE', 'STORE_ITEM_PURCHASE', 'VIP_MEMBERSHIP_PURCHASE', 'POINT_EXCHANGE_TO_COINS');

-- CreateEnum
CREATE TYPE "public"."PointTxType" AS ENUM ('LIVESTREAM_GIFT', 'SUBSCRIPTION', 'GUARDIAN_PURCHASE', 'COMMISSION', 'TRANSFER_IN', 'TRANSFER_OUT', 'PLATFORM_REWARD', 'WITHDRAWAL', 'WITHDRAWAL_REFUND', 'ADJUSTMENT', 'VIDEO_CALL', 'GIFT_RECEIVE', 'AGENCY_FORCE_EXIT_PENALTY', 'AGENT_COMMISSION', 'AGENT_POINT_TRANSFER', 'PAYROLL_PROCESSING_REWARD', 'WITHDRAWAL_ESCROW', 'WITHDRAWAL_ESCROW_SETTLED', 'PAYROLL_HOST_PAYOUT');

-- CreateEnum
CREATE TYPE "public"."WithdrawalStatus" AS ENUM ('PENDING', 'KYC_CHECK', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'PENDING_PLATFORM', 'DISPUTED');

-- CreateEnum
CREATE TYPE "public"."VipMembershipTier" AS ENUM ('DIAMOND', 'SVIP');

-- CreateEnum
CREATE TYPE "public"."FaceProfileStatus" AS ENUM ('PENDING_INDEX', 'INDEXED', 'FAILED', 'REVOKED', 'DUPLICATE_FACE');

-- CreateEnum
CREATE TYPE "public"."FaceVerificationDecision" AS ENUM ('PASS', 'FAIL', 'ERROR', 'QUALITY_REJECTED', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "public"."LivePhotoVerificationState" AS ENUM ('NOT_UPLOADED', 'PENDING_UPLOAD', 'PENDING_VERIFICATION', 'PROCESSING', 'VERIFIED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."AgencyAgentApplicationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'MORE_DOCS_REQUIRED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."LevelType" AS ENUM ('WEALTH', 'LIVESTREAM');

-- CreateEnum
CREATE TYPE "public"."SupportTicketType" AS ENUM ('CONSULT', 'REPORT_COMPLAINTS', 'FEEDBACK', 'BUSINESS_COOPERATION');

-- CreateEnum
CREATE TYPE "public"."SupportTicketStatus" AS ENUM ('OPEN', 'AWAITING_REPLY', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."SupportMessageSenderType" AS ENUM ('USER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "public"."AgencyApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."AgencyLeaveApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'LATE_APPROVED', 'AUTO_APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."AgencyHostHistoryReason" AS ENUM ('LEAVE_APPROVED', 'LEAVE_AUTO_APPROVED', 'LEAVE_LATE_APPROVED', 'REMOVED_INACTIVE', 'REMOVED_SUSPENDED', 'CS_FORCE_EXIT', 'AGENT_DELETED', 'HOST_DELETED');

-- CreateEnum
CREATE TYPE "public"."AgencyTransferChannel" AS ENUM ('BANK', 'EPAY');

-- CreateEnum
CREATE TYPE "public"."FaceRegistrationSessionStatus" AS ENUM ('PENDING', 'UPLOADED', 'PROCESSING', 'LIVENESS_PASSED', 'LIVENESS_FAILED', 'INDEX_PENDING', 'INDEXED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "public_id" BIGINT NOT NULL,
    "default_public_id" BIGINT NOT NULL,
    "first_name" VARCHAR(255),
    "last_name" VARCHAR(255),
    "date_of_birth" DATE,
    "country" VARCHAR(100),
    "gender" VARCHAR(50),
    "avatar_url" TEXT,
    "bio" TEXT,
    "username_updated_at" TIMESTAMP(3),
    "status" VARCHAR(50) NOT NULL DEFAULT 'new',
    "password_set" BOOLEAN NOT NULL DEFAULT false,
    "profile_completed_at" TIMESTAMP(3),
    "current_vip_public_id" BIGINT,
    "vip_public_id_expires_at" TIMESTAMP(3),
    "vip_purchase_at" TIMESTAMP(3),
    "original_public_id" BIGINT,
    "vip_subscription_active" BOOLEAN NOT NULL DEFAULT false,
    "vip_subscription_start_at" TIMESTAMP(3),
    "vip_subscription_expires_at" TIMESTAMP(3),
    "privacy_invisible_visitor" BOOLEAN NOT NULL DEFAULT false,
    "privacy_mystery_live" BOOLEAN NOT NULL DEFAULT false,
    "privacy_mystery_rank" BOOLEAN NOT NULL DEFAULT false,
    "privacy_invisible_online" BOOLEAN NOT NULL DEFAULT false,
    "hide_mic_status" BOOLEAN NOT NULL DEFAULT false,
    "is_support" BOOLEAN NOT NULL DEFAULT false,
    "privacy_updated_at" TIMESTAMP(3),
    "is_agent" BOOLEAN NOT NULL DEFAULT false,
    "is_tagged" BOOLEAN NOT NULL DEFAULT false,
    "last_active_at" TIMESTAMP(3),
    "current_agency_id" UUID,
    "last_ip_address" VARCHAR(45),
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."auth_identifiers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "auth_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."auth_passwords" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "previous_password_hashes" TEXT[],
    "last_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_passwords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."security_passwords" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failed_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "security_passwords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."otp_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "otp_hash" VARCHAR(255) NOT NULL,
    "otp_purpose" VARCHAR(50) NOT NULL,
    "target_identifier" VARCHAR(255) NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_name" VARCHAR(255) NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "device_fingerprint" VARCHAR(500),
    "device_fingerprint_hash" VARCHAR(64),
    "ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "refresh_token_hash" VARCHAR(255) NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "user_agent" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "login_type" VARCHAR(50),
    "token_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."device_registry" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "device_name" VARCHAR(255) NOT NULL,
    "device_type" VARCHAR(50),
    "platform" VARCHAR(20) NOT NULL DEFAULT 'web',
    "login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "device_fingerprint_hash" VARCHAR(64),
    "ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."device_linked_accounts" (
    "id" TEXT NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_linked_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vip_public_ids" (
    "id" UUID NOT NULL,
    "public_id" BIGINT NOT NULL,
    "tier" VARCHAR(50) NOT NULL DEFAULT 'NONE',
    "price_group" VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
    "rarity_score" INTEGER NOT NULL DEFAULT 0,
    "matched_rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMP(3),
    "pattern_type" VARCHAR(50),
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "current_owner_id" UUID,
    "price_credits" INTEGER,
    "purchased_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_public_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_vip_assignments" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "public_id" BIGINT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_vip_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."store_items" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" "public"."StoreItemCategory" NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "validity_days" INTEGER NOT NULL DEFAULT 15,
    "display_image_url" TEXT NOT NULL,
    "effect_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_store_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "store_item_id" UUID NOT NULL,
    "purchased_by_id" UUID NOT NULL,
    "coins_paid" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_applied" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "activated_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_active_store_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "public"."StoreItemCategory" NOT NULL,
    "user_store_item_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_active_store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action_type" VARCHAR(100) NOT NULL,
    "action_status" VARCHAR(50) NOT NULL,
    "action_details" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "device_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."account_deletions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivation_until" TIMESTAMP(3) NOT NULL,
    "deletion_at" TIMESTAMP(3) NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "reason" VARCHAR(500),
    "ip_address" VARCHAR(45),

    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."next_public_id_sequence" (
    "id" INTEGER NOT NULL,
    "next_value" BIGINT NOT NULL,

    CONSTRAINT "next_public_id_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."public_id_classification_progress" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_classified_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_id_classification_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_settings" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "allow_msg_from_mutual" BOOLEAN NOT NULL DEFAULT true,
    "allow_msg_from_following" BOOLEAN NOT NULL DEFAULT true,
    "allow_msg_from_stranger" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_follows" (
    "id" TEXT NOT NULL,
    "follower_id" UUID NOT NULL,
    "following_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."profile_visitors" (
    "id" TEXT NOT NULL,
    "profile_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_subscribers" (
    "id" TEXT NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."creator_subscriptions" (
    "id" TEXT NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "status" "public"."CreatorSubscriptionStatus" NOT NULL,
    "next_renewal_at" TIMESTAMP(3) NOT NULL,
    "grace_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."guardians" (
    "id" TEXT NOT NULL,
    "guardian_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "tier" "public"."GuardianTier" NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "coins_paid" BIGINT NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_expired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_levels" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "livestream_level" INTEGER NOT NULL DEFAULT 0,
    "wealth_level" INTEGER NOT NULL DEFAULT 0,
    "livestream_xp" BIGINT NOT NULL DEFAULT 0,
    "wealth_xp" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."level_config" (
    "id" TEXT NOT NULL,
    "level_type" VARCHAR(50) NOT NULL,
    "level" INTEGER NOT NULL,
    "min_xp" BIGINT NOT NULL,
    "max_xp" BIGINT NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "icon_url" VARCHAR(500),

    CONSTRAINT "level_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."posts" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "media_key" VARCHAR(500) NOT NULL,
    "media_url" VARCHAR(1000) NOT NULL,
    "media_type" "public"."PostMediaType" NOT NULL DEFAULT 'IMAGE',
    "thumbnail_key" VARCHAR(500),
    "thumbnail_url" VARCHAR(1000),
    "caption" TEXT,
    "visibility" "public"."PostVisibility" NOT NULL DEFAULT 'SUBSCRIBERS_ONLY',
    "subscriber_only" BOOLEAN NOT NULL DEFAULT false,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."post_tags" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "tagged_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."post_likes" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."conversations" (
    "id" TEXT NOT NULL,
    "type" "public"."ConversationType" NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."conversation_members" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMP(3),
    "last_read_message_id" TEXT,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "muted_until" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" "public"."MessageType" NOT NULL,
    "content" TEXT,
    "reply_to_id" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "client_message_id" TEXT,
    "is_auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "seq" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_outbox" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "message_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_media" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "media_type" "public"."MediaType" NOT NULL,
    "s3_key" VARCHAR(500) NOT NULL,
    "s3_bucket" VARCHAR(255) NOT NULL,
    "file_name" VARCHAR(255),
    "mime_type" VARCHAR(100),
    "size_bytes" INTEGER,
    "duration_sec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "waveform_json" JSONB,
    "codec" VARCHAR(32),
    "bitrate" INTEGER,
    "sample_rate" INTEGER,
    "channels" INTEGER,
    "processing_status" "public"."MediaProcessingStatus" NOT NULL DEFAULT 'NONE',
    "transcription_status" "public"."MediaTranscriptionStatus" NOT NULL DEFAULT 'NONE',
    "checksum_sha256" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_reactions" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."block_lists" (
    "id" TEXT NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_reports" (
    "id" TEXT NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_user_id" UUID NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "reason" "public"."ReportReason" NOT NULL,
    "additional_info" TEXT,
    "evidence_s3_keys" TEXT[],
    "status" "public"."ReportStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."broadcast_reminders" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "remind_at" TIMESTAMP(3) NOT NULL,
    "is_sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_packages" (
    "id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "label" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_type" "public"."WalletCurrencyType" NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "unconfirmed_points" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_ledger_entries" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "direction" "public"."LedgerDirection" NOT NULL,
    "tx_type" "public"."CoinTxType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_id" VARCHAR(255),
    "counterparty_id" UUID,
    "description" TEXT,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vip_membership_purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" "public"."VipMembershipTier" NOT NULL,
    "period_days" INTEGER NOT NULL,
    "coin_cost" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "expires_at_before" TIMESTAMP(3),
    "expires_at_after" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_membership_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vip_daily_claims" (
    "user_id" UUID NOT NULL,
    "claim_date" DATE NOT NULL,
    "coin_amount" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_daily_claims_pkey" PRIMARY KEY ("user_id","claim_date")
);

-- CreateTable
CREATE TABLE "public"."vip_daily_quotas" (
    "user_id" UUID NOT NULL,
    "quota_date" DATE NOT NULL,
    "quota_type" VARCHAR(50) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "max_allowed" INTEGER NOT NULL,

    CONSTRAINT "vip_daily_quotas_pkey" PRIMARY KEY ("user_id","quota_date","quota_type")
);

-- CreateTable
CREATE TABLE "public"."point_ledger_entries" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "direction" "public"."LedgerDirection" NOT NULL,
    "tx_type" "public"."PointTxType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_id" VARCHAR(255),
    "counterparty_id" UUID,
    "description" TEXT,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_topup_orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "gateway_ref" VARCHAR(256),
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "ledger_entry_id" UUID,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_topup_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_agent_applications" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "public"."AgencyAgentApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "user_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_agent_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_application_kyc" (
    "user_id" UUID NOT NULL,
    "application_id" UUID,
    "govt_id_s3_key" VARCHAR(255),
    "govt_id_s3_bucket" VARCHAR(255),
    "govt_id_submitted_at" TIMESTAMP(3),
    "contact_phone" VARCHAR(20),
    "contact_email" VARCHAR(255),
    "contact_submitted_at" TIMESTAMP(3),
    "face_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_application_kyc_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."coin_trading_topup_packages" (
    "id" UUID NOT NULL,
    "trading_coins" BIGINT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "coins_per_usd" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "label" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_trading_topup_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_trading_topup_orders" (
    "id" UUID NOT NULL,
    "agent_user_id" UUID NOT NULL,
    "package_id" UUID,
    "amount_usd" DECIMAL(12,2) NOT NULL,
    "trading_coins_awarded" BIGINT NOT NULL,
    "rate_applied" INTEGER NOT NULL,
    "epay_ref" VARCHAR(256),
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "ledger_entry_id" UUID,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_trading_topup_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_trading_transfers" (
    "id" UUID NOT NULL,
    "sender_agent_user_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "trading_coins_debited" BIGINT NOT NULL,
    "coins_credited" BIGINT NOT NULL,
    "recipient_wallet_type" VARCHAR(20) NOT NULL,
    "sender_ledger_entry_id" UUID NOT NULL,
    "recipient_ledger_entry_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "reversed_by_user_id" UUID,
    "reverse_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_trading_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coin_trading_topup_rates" (
    "id" UUID NOT NULL,
    "min_usd" DECIMAL(12,2) NOT NULL,
    "max_usd" DECIMAL(12,2),
    "coins_per_usd" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_trading_topup_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_exchange_rates" (
    "id" UUID NOT NULL,
    "min_usd_equiv" DECIMAL(12,2) NOT NULL,
    "max_usd_equiv" DECIMAL(12,2),
    "coins_per_usd" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."withdrawals" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount_points" BIGINT NOT NULL,
    "amount_fiat_cents" BIGINT,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "status" "public"."WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "payout_ref" VARCHAR(256),
    "fail_reason" TEXT,
    "notes" TEXT,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "payment_method_id" UUID,
    "host_payout_usd" DECIMAL(12,2),
    "platform_fee_points" BIGINT,
    "agent_reward_points" BIGINT,
    "assignment_count" INTEGER NOT NULL DEFAULT 0,
    "dispute_ticket_id" VARCHAR(255),
    "withdrawal_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_payment_methods" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method_type" VARCHAR(10) NOT NULL,
    "epay_email" VARCHAR(255),
    "bank_name" VARCHAR(255),
    "bank_account_holder" VARCHAR(255),
    "account_holder_first_name" VARCHAR(100),
    "account_holder_last_name" VARCHAR(100),
    "branch" VARCHAR(150),
    "bank_account_number" VARCHAR(50),
    "bank_ifsc_code" VARCHAR(20),
    "upi_number" VARCHAR(50),
    "registered_phone" VARCHAR(30),
    "registered_email" VARCHAR(255),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."withdrawal_payroll_assignments" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "proof_s3_key" VARCHAR(500),
    "proof_s3_bucket" VARCHAR(255),
    "completed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "assignment_number" INTEGER NOT NULL,
    "waiting_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_payroll_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payroll_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "platform_fee_rate_bp" INTEGER NOT NULL DEFAULT 500,
    "agent_reward_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "service_fee_usd" DECIMAL(8,2) NOT NULL DEFAULT 1.00,
    "min_withdrawal_usd" DECIMAL(12,2) NOT NULL DEFAULT 10.00,
    "max_withdrawal_usd" DECIMAL(18,2) NOT NULL DEFAULT 10000000.00,
    "sla_hours" INTEGER NOT NULL DEFAULT 2,
    "waiting_hours" INTEGER NOT NULL DEFAULT 2,
    "max_assignment_attempts" INTEGER NOT NULL DEFAULT 5,
    "inr_per_usd" DECIMAL(8,2) NOT NULL DEFAULT 94.00,
    "npr_per_usd" DECIMAL(10,4) NOT NULL DEFAULT 150.00,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "payroll_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."withdrawal_payout_rail_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "epay_fee_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "epay_arrival_time" VARCHAR(200) NOT NULL DEFAULT 'Within 24 hours',
    "bank_fee_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "bank_arrival_time" VARCHAR(200) NOT NULL DEFAULT '3-5 business days',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "withdrawal_payout_rail_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."wallet_idempotency_log" (
    "key" VARCHAR(200) NOT NULL,
    "request_hash" VARCHAR(128) NOT NULL,
    "response_snapshot" JSONB,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PROCESSING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_idempotency_log_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."wallet_level_configs" (
    "id" UUID NOT NULL,
    "level_type" "public"."LevelType" NOT NULL,
    "level" INTEGER NOT NULL,
    "threshold" BIGINT NOT NULL,
    "label" VARCHAR(255),
    "icon_key" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_level_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."wallet_user_levels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level_type" "public"."LevelType" NOT NULL,
    "current_level" INTEGER NOT NULL DEFAULT 1,
    "cumulative_total" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_user_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."video_call_settings" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "price_per_min" INTEGER NOT NULL DEFAULT 1800,
    "block_lv5" BOOLEAN NOT NULL DEFAULT false,
    "block_lv10" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_call_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."video_call_sessions" (
    "id" TEXT NOT NULL,
    "caller_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "livekit_room" VARCHAR(255) NOT NULL,
    "price_per_min" INTEGER NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    "mins_charged" INTEGER NOT NULL DEFAULT 0,
    "coins_deducted" BIGINT NOT NULL DEFAULT 0,
    "points_awarded" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" VARCHAR(100),

    CONSTRAINT "video_call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gifts" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "display_image_url" TEXT NOT NULL,
    "effect_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_tags" (
    "id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "tag" VARCHAR(64) NOT NULL,

    CONSTRAINT "gift_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_galleries" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_galleries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_gallery_sections" (
    "id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "gift_gallery_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_gallery_section_items" (
    "id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "gift_gallery_section_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_gallery_progress" (
    "id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "gift_gallery_section_item_id" UUID NOT NULL,
    "first_gifter_id" UUID NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_gallery_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."gift_transactions" (
    "id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "receiver_user_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "points_awarded" INTEGER NOT NULL,
    "context" VARCHAR(32) NOT NULL DEFAULT 'direct',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."fan_spend" (
    "id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "receiver_user_id" UUID NOT NULL,
    "period_type" VARCHAR(16) NOT NULL,
    "period_key" VARCHAR(16) NOT NULL,
    "coins_spent" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fan_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agencies" (
    "user_id" UUID NOT NULL,
    "default_public_id" BIGINT NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "payroll_enabled" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMP(3),
    "paused_until" TIMESTAMP(3),
    "total_hosts_count" INTEGER NOT NULL DEFAULT 0,
    "lifetime_host_earnings_points" BIGINT NOT NULL DEFAULT 0,
    "current_level" VARCHAR(8) NOT NULL DEFAULT 'D',
    "current_window_total_points" BIGINT NOT NULL DEFAULT 0,
    "last_level_recomputed_at" TIMESTAMP(3),
    "last_payroll_assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."agency_coinseller_settings" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "transfer_channel" "public"."AgencyTransferChannel" NOT NULL DEFAULT 'EPAY',
    "whatsapp_number" VARCHAR(30),
    "price_image_s3_key" VARCHAR(512),
    "price_image_s3_bucket" VARCHAR(128),
    "auto_reply" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_coinseller_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_hosts" (
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_hosts_pkey" PRIMARY KEY ("host_user_id")
);

-- CreateTable
CREATE TABLE "public"."agency_host_applications" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "status" "public"."AgencyApplicationStatus" NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_host_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_leave_applications" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "status" "public"."AgencyLeaveApplicationStatus" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "auto_approve_at" TIMESTAMP(3) NOT NULL,
    "late_approve_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_leave_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_host_history" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "exited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "public"."AgencyHostHistoryReason" NOT NULL,
    "exit_metadata" JSONB,

    CONSTRAINT "agency_host_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agency_commission_levels" (
    "level" VARCHAR(8) NOT NULL,
    "min_window_points" BIGINT NOT NULL,
    "live_rate_bp" INTEGER NOT NULL,
    "match_chat_rate_bp" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_commission_levels_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "public"."agency_daily_earnings" (
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "host_earnings_points" BIGINT NOT NULL DEFAULT 0,
    "host_commission_points" BIGINT NOT NULL DEFAULT 0,
    "host_was_active" BOOLEAN NOT NULL DEFAULT true,
    "last_credit_at" TIMESTAMP(3),
    "live_duration_seconds" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "agency_daily_earnings_pkey" PRIMARY KEY ("agency_user_id","host_user_id","day")
);

-- CreateTable
CREATE TABLE "public"."agency_commission_processed" (
    "host_ledger_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_commission_processed_pkey" PRIMARY KEY ("host_ledger_entry_id")
);

-- CreateTable
CREATE TABLE "public"."host_live_sessions" (
    "id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_point_transfers" (
    "id" UUID NOT NULL,
    "sender_agent_user_id" UUID NOT NULL,
    "recipient_agent_user_id" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "sender_ledger_entry_id" UUID NOT NULL,
    "recipient_ledger_entry_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_point_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."support_tickets" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "public"."SupportTicketType" NOT NULL,
    "sub_type" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT,
    "status" "public"."SupportTicketStatus" NOT NULL DEFAULT 'AWAITING_REPLY',
    "user_last_read_message_id" BIGINT,
    "cs_last_read_message_id" BIGINT,
    "rating" INTEGER,
    "rated_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."support_messages" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "ticket_id" BIGINT NOT NULL,
    "sender_user_id" UUID,
    "sender_type" "public"."SupportMessageSenderType" NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "is_auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."monthly_recharge_aggregates" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "total_recharge_coins" BIGINT NOT NULL DEFAULT 0,
    "recharge_count" INTEGER NOT NULL DEFAULT 0,
    "last_recharge_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_recharge_aggregates_pkey" PRIMARY KEY ("user_id","year","month")
);

-- CreateTable
CREATE TABLE "public"."user_rich_tier" (
    "user_id" UUID NOT NULL,
    "current_tier" INTEGER NOT NULL DEFAULT 0,
    "evaluated_from_year" INTEGER NOT NULL DEFAULT 0,
    "evaluated_from_month" INTEGER NOT NULL DEFAULT 0,
    "evaluated_recharge_coins" BIGINT NOT NULL DEFAULT 0,
    "carryover_coins" BIGINT NOT NULL DEFAULT 0,
    "last_rolled_over_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_rich_tier_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."rich_tier_history" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    "total_progress_coins" BIGINT NOT NULL,
    "carryover_applied" BIGINT NOT NULL,
    "pure_recharge_coins" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rich_tier_history_pkey" PRIMARY KEY ("user_id","year","month")
);

-- CreateTable
CREATE TABLE "public"."rich_tier_configs" (
    "tier" INTEGER NOT NULL,
    "min_recharge_coins" BIGINT NOT NULL,
    "display_name" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rich_tier_configs_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "public"."user_face_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "collection_id" TEXT NOT NULL,
    "rekognition_face_id" TEXT,
    "duplicate_of_user_id" UUID,
    "s3_key_reference" TEXT NOT NULL,
    "image_quality_score" DOUBLE PRECISION,
    "liveness_confidence" DOUBLE PRECISION,
    "status" "public"."FaceProfileStatus" NOT NULL DEFAULT 'PENDING_INDEX',
    "failure_reason" TEXT,
    "indexed_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_face_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."face_verification_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "similarity_score" DOUBLE PRECISION,
    "decision" "public"."FaceVerificationDecision" NOT NULL,
    "reason" TEXT,
    "rekognition_request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "client_request_id" UUID,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_live_photos" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_bucket" VARCHAR(255) NOT NULL,
    "image_url" TEXT,
    "verification_state" "public"."LivePhotoVerificationState" NOT NULL,
    "similarity_score" DOUBLE PRECISION,
    "verified_at" TIMESTAMP(3),
    "failed_reason" TEXT,
    "face_profile_id" UUID,
    "verify_generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_live_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."live_photo_verification_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "live_photo_id" UUID NOT NULL,
    "similarity_score" DOUBLE PRECISION,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "rekognition_request_id" VARCHAR(128),
    "failure_reason" TEXT,
    "metadata" JSONB,
    "processing_latency_ms" INTEGER,
    "rekognition_latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_photo_verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."face_registration_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "public"."FaceRegistrationSessionStatus" NOT NULL DEFAULT 'PENDING',
    "aws_session_id" VARCHAR(128),
    "challenge_sequence" JSONB NOT NULL,
    "challenge_nonce" VARCHAR(64) NOT NULL,
    "supplemental_video_s3_key" TEXT,
    "upload_nonce" VARCHAR(64),
    "risk_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "device_metadata" JSONB,
    "ip_address" VARCHAR(64),
    "failure_reason" TEXT,
    "liveness_confidence" DOUBLE PRECISION,
    "rekognition_raw_status" VARCHAR(32),
    "idempotency_key" UUID,
    "aws_request_id" VARCHAR(128),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "face_registration_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."face_registration_audit_logs" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "details" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_registration_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."questionnaires" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "require_all_correct" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "questionnaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."questionnaire_questions" (
    "id" UUID NOT NULL,
    "questionnaire_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "questionnaire_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."questionnaire_options" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,

    CONSTRAINT "questionnaire_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_questionnaire_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "questionnaire_id" UUID NOT NULL,
    "questionnaire_version" INTEGER NOT NULL,
    "total_questions" INTEGER NOT NULL,
    "correct_count" INTEGER NOT NULL,
    "all_correct" BOOLEAN NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_questionnaire_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_questionnaire_answers" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "selected_option_id" UUID,
    "selected_value" TEXT,
    "is_correct" BOOLEAN NOT NULL,

    CONSTRAINT "user_questionnaire_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ServiceRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LiveStream" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "playbackId" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LiveMessage" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StreamViewer" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamViewer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_public_id_key" ON "public"."users"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_default_public_id_key" ON "public"."users"("default_public_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_current_vip_public_id_key" ON "public"."users"("current_vip_public_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_original_public_id_key" ON "public"."users"("original_public_id");

-- CreateIndex
CREATE INDEX "users_public_id_idx" ON "public"."users"("public_id");

-- CreateIndex
CREATE INDEX "users_default_public_id_idx" ON "public"."users"("default_public_id");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "public"."users"("username");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "public"."users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "public"."users"("created_at" DESC);

-- CreateIndex
CREATE INDEX "users_is_agent_idx" ON "public"."users"("is_agent");

-- CreateIndex
CREATE INDEX "users_current_agency_id_idx" ON "public"."users"("current_agency_id");

-- CreateIndex
CREATE INDEX "users_last_active_at_idx" ON "public"."users"("last_active_at");

-- CreateIndex
CREATE INDEX "auth_identifiers_user_id_idx" ON "public"."auth_identifiers"("user_id");

-- CreateIndex
CREATE INDEX "auth_identifiers_provider_idx" ON "public"."auth_identifiers"("provider");

-- CreateIndex
CREATE INDEX "auth_identifiers_identifier_idx" ON "public"."auth_identifiers"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identifiers_provider_identifier_key" ON "public"."auth_identifiers"("provider", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identifiers_user_id_provider_key" ON "public"."auth_identifiers"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "auth_passwords_user_id_key" ON "public"."auth_passwords"("user_id");

-- CreateIndex
CREATE INDEX "auth_passwords_user_id_idx" ON "public"."auth_passwords"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "security_passwords_user_id_key" ON "public"."security_passwords"("user_id");

-- CreateIndex
CREATE INDEX "security_passwords_user_id_idx" ON "public"."security_passwords"("user_id");

-- CreateIndex
CREATE INDEX "security_passwords_locked_until_idx" ON "public"."security_passwords"("locked_until");

-- CreateIndex
CREATE INDEX "otp_tokens_user_id_idx" ON "public"."otp_tokens"("user_id");

-- CreateIndex
CREATE INDEX "otp_tokens_expires_at_idx" ON "public"."otp_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "otp_tokens_otp_purpose_idx" ON "public"."otp_tokens"("otp_purpose");

-- CreateIndex
CREATE INDEX "otp_tokens_target_identifier_otp_purpose_idx" ON "public"."otp_tokens"("target_identifier", "otp_purpose");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "public"."sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "public"."sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_device_id_idx" ON "public"."sessions"("device_id");

-- CreateIndex
CREATE INDEX "sessions_is_active_idx" ON "public"."sessions"("is_active");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "public"."sessions"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_device_id_idx" ON "public"."sessions"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "device_registry_user_id_idx" ON "public"."device_registry"("user_id");

-- CreateIndex
CREATE INDEX "device_registry_user_id_last_active_at_idx" ON "public"."device_registry"("user_id", "last_active_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_registry_user_id_device_id_key" ON "public"."device_registry"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "device_linked_accounts_device_id_idx" ON "public"."device_linked_accounts"("device_id");

-- CreateIndex
CREATE INDEX "device_linked_accounts_user_id_idx" ON "public"."device_linked_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_linked_accounts_device_id_user_id_key" ON "public"."device_linked_accounts"("device_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vip_public_ids_public_id_key" ON "public"."vip_public_ids"("public_id");

-- CreateIndex
CREATE INDEX "vip_public_ids_is_available_idx" ON "public"."vip_public_ids"("is_available");

-- CreateIndex
CREATE INDEX "vip_public_ids_current_owner_id_idx" ON "public"."vip_public_ids"("current_owner_id");

-- CreateIndex
CREATE INDEX "vip_public_ids_expires_at_idx" ON "public"."vip_public_ids"("expires_at");

-- CreateIndex
CREATE INDEX "vip_public_ids_tier_assigned_at_idx" ON "public"."vip_public_ids"("tier", "assigned_at");

-- CreateIndex
CREATE INDEX "vip_public_ids_assigned_at_idx" ON "public"."vip_public_ids"("assigned_at");

-- CreateIndex
CREATE INDEX "user_vip_assignments_user_id_is_active_idx" ON "public"."user_vip_assignments"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "user_vip_assignments_expires_at_is_active_idx" ON "public"."user_vip_assignments"("expires_at", "is_active");

-- CreateIndex
CREATE INDEX "store_items_category_is_active_sort_order_idx" ON "public"."store_items"("category", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "store_items_is_active_idx" ON "public"."store_items"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "user_store_items_idempotency_key_key" ON "public"."user_store_items"("idempotency_key");

-- CreateIndex
CREATE INDEX "user_store_items_user_id_is_applied_idx" ON "public"."user_store_items"("user_id", "is_applied");

-- CreateIndex
CREATE INDEX "user_store_items_user_id_is_active_idx" ON "public"."user_store_items"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "user_store_items_expires_at_is_active_idx" ON "public"."user_store_items"("expires_at", "is_active");

-- CreateIndex
CREATE INDEX "user_store_items_store_item_id_idx" ON "public"."user_store_items"("store_item_id");

-- CreateIndex
CREATE INDEX "user_active_store_items_user_id_idx" ON "public"."user_active_store_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_active_store_items_user_id_category_key" ON "public"."user_active_store_items"("user_id", "category");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "public"."audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_type_idx" ON "public"."audit_logs"("action_type");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "public"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "account_deletions_user_id_key" ON "public"."account_deletions"("user_id");

-- CreateIndex
CREATE INDEX "account_deletions_scheduled_at_idx" ON "public"."account_deletions"("scheduled_at");

-- CreateIndex
CREATE INDEX "account_deletions_deactivation_until_idx" ON "public"."account_deletions"("deactivation_until");

-- CreateIndex
CREATE INDEX "account_deletions_deletion_at_idx" ON "public"."account_deletions"("deletion_at");

-- CreateIndex
CREATE INDEX "account_deletions_is_deleted_idx" ON "public"."account_deletions"("is_deleted");

-- CreateIndex
CREATE INDEX "account_deletions_user_id_idx" ON "public"."account_deletions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "public"."user_settings"("user_id");

-- CreateIndex
CREATE INDEX "user_settings_user_id_idx" ON "public"."user_settings"("user_id");

-- CreateIndex
CREATE INDEX "user_follows_follower_id_idx" ON "public"."user_follows"("follower_id");

-- CreateIndex
CREATE INDEX "user_follows_following_id_idx" ON "public"."user_follows"("following_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_follows_follower_id_following_id_key" ON "public"."user_follows"("follower_id", "following_id");

-- CreateIndex
CREATE INDEX "profile_visitors_profile_id_visited_at_idx" ON "public"."profile_visitors"("profile_id", "visited_at");

-- CreateIndex
CREATE INDEX "profile_visitors_visitor_id_visited_at_idx" ON "public"."profile_visitors"("visitor_id", "visited_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_visitors_profile_id_visitor_id_key" ON "public"."profile_visitors"("profile_id", "visitor_id");

-- CreateIndex
CREATE INDEX "user_subscribers_creator_id_idx" ON "public"."user_subscribers"("creator_id");

-- CreateIndex
CREATE INDEX "user_subscribers_subscriber_id_idx" ON "public"."user_subscribers"("subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscribers_subscriber_id_creator_id_key" ON "public"."user_subscribers"("subscriber_id", "creator_id");

-- CreateIndex
CREATE INDEX "creator_subscriptions_next_renewal_at_status_idx" ON "public"."creator_subscriptions"("next_renewal_at", "status");

-- CreateIndex
CREATE INDEX "creator_subscriptions_subscriber_id_status_idx" ON "public"."creator_subscriptions"("subscriber_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_subscriptions_subscriber_id_creator_id_key" ON "public"."creator_subscriptions"("subscriber_id", "creator_id");

-- CreateIndex
CREATE INDEX "guardians_target_user_id_is_expired_expires_at_idx" ON "public"."guardians"("target_user_id", "is_expired", "expires_at");

-- CreateIndex
CREATE INDEX "guardians_guardian_user_id_is_expired_idx" ON "public"."guardians"("guardian_user_id", "is_expired");

-- CreateIndex
CREATE INDEX "guardians_expires_at_is_expired_idx" ON "public"."guardians"("expires_at", "is_expired");

-- CreateIndex
CREATE UNIQUE INDEX "guardians_guardian_user_id_target_user_id_key" ON "public"."guardians"("guardian_user_id", "target_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_levels_user_id_key" ON "public"."user_levels"("user_id");

-- CreateIndex
CREATE INDEX "level_config_level_type_idx" ON "public"."level_config"("level_type");

-- CreateIndex
CREATE UNIQUE INDEX "level_config_level_type_level_key" ON "public"."level_config"("level_type", "level");

-- CreateIndex
CREATE INDEX "posts_user_id_created_at_idx" ON "public"."posts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_user_id_created_at_id_idx" ON "public"."posts"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "public"."posts"("created_at");

-- CreateIndex
CREATE INDEX "post_tags_post_id_idx" ON "public"."post_tags"("post_id");

-- CreateIndex
CREATE INDEX "post_tags_tagged_user_id_idx" ON "public"."post_tags"("tagged_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_tags_post_id_tagged_user_id_key" ON "public"."post_tags"("post_id", "tagged_user_id");

-- CreateIndex
CREATE INDEX "post_likes_post_id_idx" ON "public"."post_likes"("post_id");

-- CreateIndex
CREATE INDEX "post_likes_user_id_idx" ON "public"."post_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_likes_post_id_user_id_key" ON "public"."post_likes"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "public"."conversations"("last_message_at");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_idx" ON "public"."conversation_members"("user_id");

-- CreateIndex
CREATE INDEX "conversation_members_conversation_id_idx" ON "public"."conversation_members"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversation_id_user_id_key" ON "public"."conversation_members"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_seq_idx" ON "public"."messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "public"."messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "public"."messages"("sender_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "public"."messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "public"."messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "message_outbox_published_at_id_idx" ON "public"."message_outbox"("published_at", "id");

-- CreateIndex
CREATE INDEX "message_media_message_id_idx" ON "public"."message_media"("message_id");

-- CreateIndex
CREATE INDEX "message_media_processing_status_created_at_idx" ON "public"."message_media"("processing_status", "created_at");

-- CreateIndex
CREATE INDEX "message_media_created_at_idx" ON "public"."message_media"("created_at");

-- CreateIndex
CREATE INDEX "message_reactions_message_id_idx" ON "public"."message_reactions"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_user_id_emoji_key" ON "public"."message_reactions"("message_id", "user_id", "emoji");

-- CreateIndex
CREATE INDEX "block_lists_blocker_id_idx" ON "public"."block_lists"("blocker_id");

-- CreateIndex
CREATE INDEX "block_lists_blocked_id_idx" ON "public"."block_lists"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "block_lists_blocker_id_blocked_id_key" ON "public"."block_lists"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "message_reports_reporter_id_idx" ON "public"."message_reports"("reporter_id");

-- CreateIndex
CREATE INDEX "message_reports_reported_user_id_idx" ON "public"."message_reports"("reported_user_id");

-- CreateIndex
CREATE INDEX "message_reports_created_at_idx" ON "public"."message_reports"("created_at");

-- CreateIndex
CREATE INDEX "broadcast_reminders_remind_at_is_sent_idx" ON "public"."broadcast_reminders"("remind_at", "is_sent");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_reminders_user_id_creator_id_key" ON "public"."broadcast_reminders"("user_id", "creator_id");

-- CreateIndex
CREATE INDEX "coin_packages_is_active_sort_order_idx" ON "public"."coin_packages"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "coin_packages_coins_price_cents_key" ON "public"."coin_packages"("coins", "price_cents");

-- CreateIndex
CREATE INDEX "wallets_user_id_idx" ON "public"."wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_type_key" ON "public"."wallets"("user_id", "currency_type");

-- CreateIndex
CREATE UNIQUE INDEX "coin_ledger_entries_idempotency_key_key" ON "public"."coin_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_ledger_entries_wallet_id_created_at_idx" ON "public"."coin_ledger_entries"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_ledger_entries_wallet_id_tx_type_created_at_idx" ON "public"."coin_ledger_entries"("wallet_id", "tx_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_ledger_entries_idempotency_key_idx" ON "public"."coin_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "vip_membership_purchases_user_id_created_at_idx" ON "public"."vip_membership_purchases"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "vip_membership_purchases_tier_created_at_idx" ON "public"."vip_membership_purchases"("tier", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "vip_membership_purchases_ledger_entry_id_key" ON "public"."vip_membership_purchases"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "vip_daily_claims_user_id_claim_date_idx" ON "public"."vip_daily_claims"("user_id", "claim_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_entries_idempotency_key_key" ON "public"."point_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_created_at_idx" ON "public"."point_ledger_entries"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_tx_type_created_at_idx" ON "public"."point_ledger_entries"("wallet_id", "tx_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_tx_type_direction_created_at_idx" ON "public"."point_ledger_entries"("wallet_id", "tx_type", "direction", "created_at");

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_ref_id_idx" ON "public"."point_ledger_entries"("wallet_id", "ref_id");

-- CreateIndex
CREATE INDEX "point_ledger_entries_idempotency_key_idx" ON "public"."point_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "coin_topup_orders_gateway_ref_key" ON "public"."coin_topup_orders"("gateway_ref");

-- CreateIndex
CREATE UNIQUE INDEX "coin_topup_orders_idempotency_key_key" ON "public"."coin_topup_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_topup_orders_user_id_created_at_idx" ON "public"."coin_topup_orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agency_agent_applications_public_id_key" ON "public"."agency_agent_applications"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "agency_agent_applications_user_id_key" ON "public"."agency_agent_applications"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agency_application_kyc_application_id_key" ON "public"."agency_application_kyc"("application_id");

-- CreateIndex
CREATE INDEX "coin_trading_topup_packages_is_active_sort_order_idx" ON "public"."coin_trading_topup_packages"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_topup_packages_trading_coins_price_cents_key" ON "public"."coin_trading_topup_packages"("trading_coins", "price_cents");

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_topup_orders_epay_ref_key" ON "public"."coin_trading_topup_orders"("epay_ref");

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_topup_orders_idempotency_key_key" ON "public"."coin_trading_topup_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_trading_topup_orders_agent_user_id_created_at_idx" ON "public"."coin_trading_topup_orders"("agent_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_trading_topup_orders_status_created_at_idx" ON "public"."coin_trading_topup_orders"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_transfers_idempotency_key_key" ON "public"."coin_trading_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_trading_transfers_sender_agent_user_id_created_at_idx" ON "public"."coin_trading_transfers"("sender_agent_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_trading_transfers_recipient_user_id_created_at_idx" ON "public"."coin_trading_transfers"("recipient_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_trading_topup_rates_is_active_sort_order_idx" ON "public"."coin_trading_topup_rates"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "agent_exchange_rates_is_active_sort_order_idx" ON "public"."agent_exchange_rates"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_idempotency_key_key" ON "public"."withdrawals"("idempotency_key");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_status_idx" ON "public"."withdrawals"("user_id", "status");

-- CreateIndex
CREATE INDEX "withdrawals_wallet_id_requested_at_idx" ON "public"."withdrawals"("wallet_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "user_payment_methods_user_id_idx" ON "public"."user_payment_methods"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_payment_methods_user_id_method_type_key" ON "public"."user_payment_methods"("user_id", "method_type");

-- CreateIndex
CREATE INDEX "withdrawal_payroll_assignments_withdrawal_id_assignment_num_idx" ON "public"."withdrawal_payroll_assignments"("withdrawal_id", "assignment_number");

-- CreateIndex
CREATE INDEX "withdrawal_payroll_assignments_agency_user_id_status_assign_idx" ON "public"."withdrawal_payroll_assignments"("agency_user_id", "status", "assigned_at" DESC);

-- CreateIndex
CREATE INDEX "withdrawal_payroll_assignments_status_expires_at_idx" ON "public"."withdrawal_payroll_assignments"("status", "expires_at");

-- CreateIndex
CREATE INDEX "withdrawal_payroll_assignments_agency_user_id_status_update_idx" ON "public"."withdrawal_payroll_assignments"("agency_user_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_idempotency_log_expires_at_idx" ON "public"."wallet_idempotency_log"("expires_at");

-- CreateIndex
CREATE INDEX "wallet_level_configs_level_type_threshold_idx" ON "public"."wallet_level_configs"("level_type", "threshold");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_level_configs_level_type_level_key" ON "public"."wallet_level_configs"("level_type", "level");

-- CreateIndex
CREATE INDEX "wallet_user_levels_user_id_idx" ON "public"."wallet_user_levels"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_user_levels_user_id_level_type_key" ON "public"."wallet_user_levels"("user_id", "level_type");

-- CreateIndex
CREATE UNIQUE INDEX "video_call_settings_user_id_key" ON "public"."video_call_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_call_sessions_livekit_room_key" ON "public"."video_call_sessions"("livekit_room");

-- CreateIndex
CREATE INDEX "video_call_sessions_caller_id_status_idx" ON "public"."video_call_sessions"("caller_id", "status");

-- CreateIndex
CREATE INDEX "video_call_sessions_creator_id_status_idx" ON "public"."video_call_sessions"("creator_id", "status");

-- CreateIndex
CREATE INDEX "video_call_sessions_livekit_room_idx" ON "public"."video_call_sessions"("livekit_room");

-- CreateIndex
CREATE INDEX "gifts_is_active_idx" ON "public"."gifts"("is_active");

-- CreateIndex
CREATE INDEX "gift_tags_tag_idx" ON "public"."gift_tags"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "gift_tags_gift_id_tag_key" ON "public"."gift_tags"("gift_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "gift_galleries_year_month_key" ON "public"."gift_galleries"("year", "month");

-- CreateIndex
CREATE INDEX "gift_gallery_sections_gallery_id_idx" ON "public"."gift_gallery_sections"("gallery_id");

-- CreateIndex
CREATE INDEX "gift_gallery_section_items_gift_id_idx" ON "public"."gift_gallery_section_items"("gift_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_gallery_section_items_section_id_gift_id_key" ON "public"."gift_gallery_section_items"("section_id", "gift_id");

-- CreateIndex
CREATE INDEX "gift_gallery_progress_host_user_id_gallery_id_idx" ON "public"."gift_gallery_progress"("host_user_id", "gallery_id");

-- CreateIndex
CREATE INDEX "gift_gallery_progress_gallery_id_idx" ON "public"."gift_gallery_progress"("gallery_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_gallery_progress_host_user_id_gift_gallery_section_ite_key" ON "public"."gift_gallery_progress"("host_user_id", "gift_gallery_section_item_id");

-- CreateIndex
CREATE INDEX "gift_transactions_sender_user_id_idx" ON "public"."gift_transactions"("sender_user_id");

-- CreateIndex
CREATE INDEX "gift_transactions_receiver_user_id_idx" ON "public"."gift_transactions"("receiver_user_id");

-- CreateIndex
CREATE INDEX "gift_transactions_created_at_idx" ON "public"."gift_transactions"("created_at");

-- CreateIndex
CREATE INDEX "fan_spend_receiver_user_id_period_type_period_key_idx" ON "public"."fan_spend"("receiver_user_id", "period_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "fan_spend_sender_user_id_receiver_user_id_period_type_perio_key" ON "public"."fan_spend"("sender_user_id", "receiver_user_id", "period_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "agencies_default_public_id_key" ON "public"."agencies"("default_public_id");

-- CreateIndex
CREATE INDEX "agencies_payroll_enabled_paused_at_idx" ON "public"."agencies"("payroll_enabled", "paused_at");

-- CreateIndex
CREATE INDEX "agencies_payroll_enabled_paused_at_last_payroll_assigned_at_idx" ON "public"."agencies"("payroll_enabled", "paused_at", "last_payroll_assigned_at");

-- CreateIndex
CREATE INDEX "agencies_current_level_current_window_total_points_idx" ON "public"."agencies"("current_level", "current_window_total_points" DESC);

-- CreateIndex
CREATE INDEX "agencies_total_hosts_count_idx" ON "public"."agencies"("total_hosts_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agency_coinseller_settings_agency_user_id_key" ON "public"."agency_coinseller_settings"("agency_user_id");

-- CreateIndex
CREATE INDEX "agency_hosts_agency_user_id_joined_at_idx" ON "public"."agency_hosts"("agency_user_id", "joined_at" DESC);

-- CreateIndex
CREATE INDEX "agency_host_applications_host_user_id_status_created_at_idx" ON "public"."agency_host_applications"("host_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_host_applications_agency_user_id_status_created_at_idx" ON "public"."agency_host_applications"("agency_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_leave_applications_host_user_id_status_created_at_idx" ON "public"."agency_leave_applications"("host_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_leave_applications_agency_user_id_status_created_at_idx" ON "public"."agency_leave_applications"("agency_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_leave_applications_status_auto_approve_at_idx" ON "public"."agency_leave_applications"("status", "auto_approve_at");

-- CreateIndex
CREATE INDEX "agency_host_history_host_user_id_exited_at_idx" ON "public"."agency_host_history"("host_user_id", "exited_at" DESC);

-- CreateIndex
CREATE INDEX "agency_host_history_agency_user_id_exited_at_idx" ON "public"."agency_host_history"("agency_user_id", "exited_at" DESC);

-- CreateIndex
CREATE INDEX "agency_daily_earnings_agency_user_id_day_idx" ON "public"."agency_daily_earnings"("agency_user_id", "day" DESC);

-- CreateIndex
CREATE INDEX "agency_daily_earnings_host_user_id_day_idx" ON "public"."agency_daily_earnings"("host_user_id", "day" DESC);

-- CreateIndex
CREATE INDEX "host_live_sessions_host_user_id_status_idx" ON "public"."host_live_sessions"("host_user_id", "status");

-- CreateIndex
CREATE INDEX "host_live_sessions_agency_user_id_started_at_idx" ON "public"."host_live_sessions"("agency_user_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_point_transfers_idempotency_key_key" ON "public"."agent_point_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "agent_point_transfers_sender_agent_user_id_created_at_idx" ON "public"."agent_point_transfers"("sender_agent_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_point_transfers_recipient_agent_user_id_created_at_idx" ON "public"."agent_point_transfers"("recipient_agent_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_public_id_key" ON "public"."support_tickets"("public_id");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_status_updated_at_idx" ON "public"."support_tickets"("user_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_updated_at_idx" ON "public"."support_tickets"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_public_id_key" ON "public"."support_messages"("public_id");

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "public"."support_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "monthly_recharge_aggregates_year_month_total_recharge_coins_idx" ON "public"."monthly_recharge_aggregates"("year", "month", "total_recharge_coins" DESC);

-- CreateIndex
CREATE INDEX "user_rich_tier_current_tier_evaluated_from_year_evaluated_f_idx" ON "public"."user_rich_tier"("current_tier", "evaluated_from_year", "evaluated_from_month");

-- CreateIndex
CREATE INDEX "rich_tier_history_year_month_tier_idx" ON "public"."rich_tier_history"("year", "month", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "user_face_profiles_user_id_key" ON "public"."user_face_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_face_profiles_rekognition_face_id_key" ON "public"."user_face_profiles"("rekognition_face_id");

-- CreateIndex
CREATE INDEX "user_face_profiles_status_idx" ON "public"."user_face_profiles"("status");

-- CreateIndex
CREATE INDEX "face_verification_attempts_user_id_created_at_idx" ON "public"."face_verification_attempts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "face_verification_attempts_decision_created_at_idx" ON "public"."face_verification_attempts"("decision", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "face_verification_attempts_user_id_client_request_id_key" ON "public"."face_verification_attempts"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_live_photos_user_id_key" ON "public"."user_live_photos"("user_id");

-- CreateIndex
CREATE INDEX "user_live_photos_verification_state_idx" ON "public"."user_live_photos"("verification_state");

-- CreateIndex
CREATE INDEX "live_photo_verification_attempts_user_id_created_at_idx" ON "public"."live_photo_verification_attempts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "live_photo_verification_attempts_live_photo_id_created_at_idx" ON "public"."live_photo_verification_attempts"("live_photo_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "face_registration_sessions_user_id_status_idx" ON "public"."face_registration_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "face_registration_sessions_user_id_created_at_idx" ON "public"."face_registration_sessions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "face_registration_sessions_expires_at_idx" ON "public"."face_registration_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "face_registration_audit_logs_session_id_created_at_idx" ON "public"."face_registration_audit_logs"("session_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "face_registration_audit_logs_user_id_created_at_idx" ON "public"."face_registration_audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "questionnaires_key_is_active_idx" ON "public"."questionnaires"("key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaires_key_version_key" ON "public"."questionnaires"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_questions_questionnaire_id_order_key" ON "public"."questionnaire_questions"("questionnaire_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_options_question_id_value_key" ON "public"."questionnaire_options"("question_id", "value");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_options_question_id_order_key" ON "public"."questionnaire_options"("question_id", "order");

-- CreateIndex
CREATE INDEX "user_questionnaire_attempts_user_id_questionnaire_id_comple_idx" ON "public"."user_questionnaire_attempts"("user_id", "questionnaire_id", "completed_at" DESC);

-- CreateIndex
CREATE INDEX "user_questionnaire_attempts_user_id_questionnaire_id_questi_idx" ON "public"."user_questionnaire_attempts"("user_id", "questionnaire_id", "questionnaire_version", "all_correct");

-- CreateIndex
CREATE UNIQUE INDEX "user_questionnaire_answers_attempt_id_question_id_key" ON "public"."user_questionnaire_answers"("attempt_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "LiveStream_streamId_key" ON "public"."LiveStream"("streamId");

-- CreateIndex
CREATE UNIQUE INDEX "StreamViewer_streamId_userId_key" ON "public"."StreamViewer"("streamId", "userId");

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_current_agency_id_fkey" FOREIGN KEY ("current_agency_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."auth_identifiers" ADD CONSTRAINT "auth_identifiers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."auth_passwords" ADD CONSTRAINT "auth_passwords_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."security_passwords" ADD CONSTRAINT "security_passwords_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."otp_tokens" ADD CONSTRAINT "otp_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."device_registry" ADD CONSTRAINT "device_registry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."device_linked_accounts" ADD CONSTRAINT "device_linked_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_public_ids" ADD CONSTRAINT "vip_public_ids_current_owner_id_fkey" FOREIGN KEY ("current_owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_vip_assignments" ADD CONSTRAINT "user_vip_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_vip_assignments" ADD CONSTRAINT "user_vip_assignments_public_id_fkey" FOREIGN KEY ("public_id") REFERENCES "public"."vip_public_ids"("public_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_store_items" ADD CONSTRAINT "user_store_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_store_items" ADD CONSTRAINT "user_store_items_purchased_by_id_fkey" FOREIGN KEY ("purchased_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_store_items" ADD CONSTRAINT "user_store_items_store_item_id_fkey" FOREIGN KEY ("store_item_id") REFERENCES "public"."store_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_active_store_items" ADD CONSTRAINT "user_active_store_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_active_store_items" ADD CONSTRAINT "user_active_store_items_user_store_item_id_fkey" FOREIGN KEY ("user_store_item_id") REFERENCES "public"."user_store_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."account_deletions" ADD CONSTRAINT "account_deletions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_follows" ADD CONSTRAINT "user_follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_follows" ADD CONSTRAINT "user_follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profile_visitors" ADD CONSTRAINT "profile_visitors_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profile_visitors" ADD CONSTRAINT "profile_visitors_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_subscribers" ADD CONSTRAINT "user_subscribers_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_subscribers" ADD CONSTRAINT "user_subscribers_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."creator_subscriptions" ADD CONSTRAINT "creator_subscriptions_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."creator_subscriptions" ADD CONSTRAINT "creator_subscriptions_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."guardians" ADD CONSTRAINT "guardians_guardian_user_id_fkey" FOREIGN KEY ("guardian_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."guardians" ADD CONSTRAINT "guardians_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_levels" ADD CONSTRAINT "user_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."posts" ADD CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."post_tags" ADD CONSTRAINT "post_tags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."post_tags" ADD CONSTRAINT "post_tags_tagged_user_id_fkey" FOREIGN KEY ("tagged_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."post_likes" ADD CONSTRAINT "post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."post_likes" ADD CONSTRAINT "post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_media" ADD CONSTRAINT "message_media_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."block_lists" ADD CONSTRAINT "block_lists_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."block_lists" ADD CONSTRAINT "block_lists_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reports" ADD CONSTRAINT "message_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_reports" ADD CONSTRAINT "message_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."broadcast_reminders" ADD CONSTRAINT "broadcast_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."broadcast_reminders" ADD CONSTRAINT "broadcast_reminders_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_ledger_entries" ADD CONSTRAINT "coin_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_membership_purchases" ADD CONSTRAINT "vip_membership_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_membership_purchases" ADD CONSTRAINT "vip_membership_purchases_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_daily_claims" ADD CONSTRAINT "vip_daily_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_daily_claims" ADD CONSTRAINT "vip_daily_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vip_daily_quotas" ADD CONSTRAINT "vip_daily_quotas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."point_ledger_entries" ADD CONSTRAINT "point_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_topup_orders" ADD CONSTRAINT "coin_topup_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."coin_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_agent_applications" ADD CONSTRAINT "agency_agent_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_application_kyc" ADD CONSTRAINT "agency_application_kyc_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_application_kyc" ADD CONSTRAINT "agency_application_kyc_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."agency_agent_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_trading_topup_orders" ADD CONSTRAINT "coin_trading_topup_orders_agent_user_id_fkey" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_trading_topup_orders" ADD CONSTRAINT "coin_trading_topup_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."coin_trading_topup_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_trading_transfers" ADD CONSTRAINT "coin_trading_transfers_sender_agent_user_id_fkey" FOREIGN KEY ("sender_agent_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_trading_transfers" ADD CONSTRAINT "coin_trading_transfers_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coin_trading_transfers" ADD CONSTRAINT "coin_trading_transfers_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."withdrawals" ADD CONSTRAINT "withdrawals_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."user_payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_payment_methods" ADD CONSTRAINT "user_payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."withdrawal_payroll_assignments" ADD CONSTRAINT "withdrawal_payroll_assignments_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."withdrawal_payroll_assignments" ADD CONSTRAINT "withdrawal_payroll_assignments_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."wallet_user_levels" ADD CONSTRAINT "wallet_user_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."video_call_settings" ADD CONSTRAINT "video_call_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."video_call_sessions" ADD CONSTRAINT "video_call_sessions_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."video_call_sessions" ADD CONSTRAINT "video_call_sessions_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_tags" ADD CONSTRAINT "gift_tags_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_sections" ADD CONSTRAINT "gift_gallery_sections_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "public"."gift_galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_section_items" ADD CONSTRAINT "gift_gallery_section_items_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."gift_gallery_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_section_items" ADD CONSTRAINT "gift_gallery_section_items_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "public"."gift_galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_first_gifter_id_fkey" FOREIGN KEY ("first_gifter_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gift_gallery_section_item_id_fkey" FOREIGN KEY ("gift_gallery_section_item_id") REFERENCES "public"."gift_gallery_section_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_transactions" ADD CONSTRAINT "gift_transactions_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_transactions" ADD CONSTRAINT "gift_transactions_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."gift_transactions" ADD CONSTRAINT "gift_transactions_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fan_spend" ADD CONSTRAINT "fan_spend_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fan_spend" ADD CONSTRAINT "fan_spend_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agencies" ADD CONSTRAINT "agencies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_coinseller_settings" ADD CONSTRAINT "agency_coinseller_settings_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_hosts" ADD CONSTRAINT "agency_hosts_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_hosts" ADD CONSTRAINT "agency_hosts_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_host_applications" ADD CONSTRAINT "agency_host_applications_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_host_applications" ADD CONSTRAINT "agency_host_applications_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_host_applications" ADD CONSTRAINT "agency_host_applications_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_daily_earnings" ADD CONSTRAINT "agency_daily_earnings_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "public"."agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agency_daily_earnings" ADD CONSTRAINT "agency_daily_earnings_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."host_live_sessions" ADD CONSTRAINT "host_live_sessions_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_point_transfers" ADD CONSTRAINT "agent_point_transfers_sender_agent_user_id_fkey" FOREIGN KEY ("sender_agent_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_point_transfers" ADD CONSTRAINT "agent_point_transfers_recipient_agent_user_id_fkey" FOREIGN KEY ("recipient_agent_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."support_messages" ADD CONSTRAINT "support_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."monthly_recharge_aggregates" ADD CONSTRAINT "monthly_recharge_aggregates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_rich_tier" ADD CONSTRAINT "user_rich_tier_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rich_tier_history" ADD CONSTRAINT "rich_tier_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_face_profiles" ADD CONSTRAINT "user_face_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."face_verification_attempts" ADD CONSTRAINT "face_verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_live_photos" ADD CONSTRAINT "user_live_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_live_photos" ADD CONSTRAINT "user_live_photos_face_profile_id_fkey" FOREIGN KEY ("face_profile_id") REFERENCES "public"."user_face_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."live_photo_verification_attempts" ADD CONSTRAINT "live_photo_verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."live_photo_verification_attempts" ADD CONSTRAINT "live_photo_verification_attempts_live_photo_id_fkey" FOREIGN KEY ("live_photo_id") REFERENCES "public"."user_live_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."face_registration_sessions" ADD CONSTRAINT "face_registration_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."face_registration_audit_logs" ADD CONSTRAINT "face_registration_audit_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."face_registration_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."face_registration_audit_logs" ADD CONSTRAINT "face_registration_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."questionnaire_questions" ADD CONSTRAINT "questionnaire_questions_questionnaire_id_fkey" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."questionnaire_options" ADD CONSTRAINT "questionnaire_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questionnaire_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_questionnaire_attempts" ADD CONSTRAINT "user_questionnaire_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_questionnaire_attempts" ADD CONSTRAINT "user_questionnaire_attempts_questionnaire_id_fkey" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_questionnaire_answers" ADD CONSTRAINT "user_questionnaire_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."user_questionnaire_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_questionnaire_answers" ADD CONSTRAINT "user_questionnaire_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questionnaire_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
