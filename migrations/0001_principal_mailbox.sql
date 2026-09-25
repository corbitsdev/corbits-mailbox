CREATE SCHEMA IF NOT EXISTS "mailbox";

-- The mail plane, in this package's own schema in the host's database. The
-- scope FKs point at the host's control plane ("public" is rewritten to the
-- host schema), so a tenant or principal deletion carries its mail with it.
-- Constraint names follow drizzle's convention.
CREATE TABLE IF NOT EXISTS "mailbox"."principal_mail" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "address" text NOT NULL,
  "direction" text NOT NULL,
  "raw" bytea NOT NULL,
  "subject" text,
  "from_address" text,
  "message_key" text,
  "refs" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "principal_mail_tenant_id_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant" ("id") ON DELETE CASCADE,
  CONSTRAINT "principal_mail_principal_id_principal_id_fk"
    FOREIGN KEY ("principal_id") REFERENCES "public"."principal" ("id") ON DELETE CASCADE
);

-- Partial: mail without a stable message key is left unconstrained.
DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_tenant_id_principal_id_message_key_idx"') IS NULL THEN
    CREATE UNIQUE INDEX "principal_mail_tenant_id_principal_id_message_key_idx"
      ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "message_key")
      WHERE "message_key" IS NOT NULL;
  END IF;
END $$;

-- Matches the list query's (created_at DESC, id DESC) keyset order.
DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_tenant_id_principal_id_created_at_id_idx"') IS NULL THEN
    CREATE INDEX "principal_mail_tenant_id_principal_id_created_at_id_idx"
      ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "created_at" DESC, "id" DESC);
  END IF;
END $$;
