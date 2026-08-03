-- Add the provider-owned, display-only catalog key to the cached catalog table.
-- Nullable so pre-existing cached rows remain valid until the next catalog
-- refresh populates their key. This column is CATALOG-DISPLAY-ONLY and is
-- deliberately NOT added to policies / premiums / claims.
ALTER TABLE "policy_catalog" ADD COLUMN "key" TEXT;
