# ADR-010: Product photos in a private S3 bucket

- Status: **Accepted**
- Date: 2026-10-07

## Decision

Product photos are stored in **AWS S3** (`althobe-product-images`, `eu-central-1`, private), written
and read only through the API with a dedicated IAM user (`althobe-app-s3`).

| Piece | How |
| --- | --- |
| Upload | The browser shrinks each photo (canvas: 1600 px image + 400 px thumbnail, WebP or JPEG) and sends both as base64 in JSON to `POST /products/:id/photos` (route body limit 5 MB) |
| Checks | The server reads the type from the first bytes (JPEG, WebP, PNG only — never SVG), caps sizes (3 MB / 300 KB), and makes the S3 keys itself: `products/<productId>/<photoId>[-thumb].<ext>` |
| Display | `<img src="/api/v1/photos/:id?size=thumb">`: the API checks the session, then redirects (302) to a signed S3 link. The link is signed as of the start of the hour, so repeated loads reuse the browser cache |
| Tables | `product_photos` (keys, type, size, dimensions, order, who, when; soft-deleted) and `product_photo_values` (the option values a photo shows) |
| Matching | A variant shows the photo whose tags are all among its values, with the most tags; ties go to the earlier photo. Untagged photos are general photos. The first photo is the product's main photo |
| Separation | Practice mode stores under `practice/`, test runs under `S3_PREFIX` (e.g. `test/`); automated tests use an in-memory store |
| Secrets | `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in `backend/.env` (development) and Railway variables (production); without them the app runs with photos off |

New dependencies: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` — the official AWS
SDK, needed to write to S3 and sign read links. No image library: shrinking happens in the browser.

## Why

- **Through the API, not browser-to-S3:** no bucket CORS rule, one place that checks the bytes and
  the permission, and keys the client cannot choose. Shrunk photos are small, so the extra hop costs
  little.
- **Private bucket + signed links:** product photos are business data; a public bucket would show
  them to anyone with a URL.
- **Tags instead of photos per variant:** one photo of a navy formal suit serves every size of it,
  yet each variant still shows its own look.

## Consequences

- Deleting a photo soft-deletes the row, then removes both files. If S3 fails after the commit, an
  orphaned file remains (harmless, can be swept); a row never points at a missing file.
- Uploads need `products.write`; viewing needs `products.read`.
- The IAM user needs only `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on the bucket.
