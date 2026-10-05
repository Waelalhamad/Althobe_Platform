-- Product photos in S3 (ADR-010), tagged with the option values they show.

-- CreateTable
CREATE TABLE "product_photos" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_key" TEXT NOT NULL,
    "thumb_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_photo_values" (
    "photo_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "product_photo_values_pkey" PRIMARY KEY ("photo_id","value_id")
);

-- CreateIndex
CREATE INDEX "idx_product_photos_product_id" ON "product_photos"("product_id");

-- CreateIndex
CREATE INDEX "idx_product_photo_values_value_id" ON "product_photo_values"("value_id");

-- AddForeignKey
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_photo_values" ADD CONSTRAINT "product_photo_values_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "product_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_photo_values" ADD CONSTRAINT "product_photo_values_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "option_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sizes as the service enforces them: a full image of at most 3 MB, real dimensions.
ALTER TABLE "product_photos"
  ADD CONSTRAINT "ck_product_photos_size" CHECK ("byte_size" > 0 AND "byte_size" <= 3145728),
  ADD CONSTRAINT "ck_product_photos_dimensions" CHECK ("width" > 0 AND "height" > 0),
  ADD CONSTRAINT "ck_product_photos_content_type" CHECK ("content_type" IN ('image/jpeg', 'image/webp', 'image/png'));
