# Infinity Space Backend

Node / Express API that issues pre-signed S3 uploads for the import page.

## Setup

```bash
cd backend
cp .env.example .env
npm install
```

Edit the `.env` file with your AWS credentials and S3 bucket information.

## Running locally

```bash
npm run dev
```

The server listens on port `4000` by default and exposes:

- `GET /health` — service health check  
- `POST /api/import` — returns a pre-signed POST payload for uploading the captured image to S3

## `POST /api/import`

### Request body

```json
{
  "fileName": "BARCODE_CAM1_20240101T120000Z.png",
  "contentType": "image/png",
  "scan": "barcode payload",
  "camera": 1,
  "timestamp": 1704110400000
}
```

### Response

```json
{
  "url": "https://your-bucket.s3.amazonaws.com",
  "fields": {
    "key": "uploads/BARCODE_CAM1_20240101T120000Z.png",
    "...": "...",
    "policy": "...",
    "x-amz-signature": "..."
  },
  "finalUrl": "https://your-bucket.s3.amazonaws.com/uploads/BARCODE_CAM1_20240101T120000Z.png",
  "expiresIn": 60,
  "key": "uploads/BARCODE_CAM1_20240101T120000Z.png"
}
```

The frontend should submit the provided `fields` (plus the binary file) to `url` using a `multipart/form-data` POST. The `finalUrl` indicates where the object will live after a successful upload.

## Environment variables

- `PORT` — HTTP port to bind (default `4000`)
- `AWS_REGION` — AWS region hosting your S3 bucket
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` — standard AWS credentials (can be omitted when using IAM roles)
- `S3_BUCKET_NAME` — bucket that will store uploaded images
- `S3_KEY_PREFIX` — optional folder prefix (e.g. `uploads/`)
- `S3_PRESIGN_TTL` — seconds the pre-signed request stays valid (max `900`)
- `ALLOWED_ORIGINS` — comma-separated list of allowed CORS origins
- `MAX_UPLOAD_BYTES` — maximum upload size, defaults to 5 MB
