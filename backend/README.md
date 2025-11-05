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
- `WS /ws` — primary API (pre-sign, analysis, status streaming)

## WebSocket API

All ingest operations happen over a single WebSocket connection. The backend streams status events so clients can show “uploading”, “running AI”, and “persisting to DynamoDB” heartbeats while long tasks run.

### Connecting

1. Open `ws(s)://<host>/ws`. The server responds with a `ready` message followed by an optional `snapshot` of recent operations.
2. The server periodically pings clients. Browsers reply automatically; no special handling is required.
3. On reconnect, reissue the connection. The initial `snapshot` replays the latest statuses for any scans still in progress.

### Client → Server messages

- `presign_request`

  ```jsonc
  {
    "type": "presign_request",
    "requestId": "uuid",
    "payload": {
      "scan": "H10011",
      "fileName": "H10011_CAM1_20251104.png",
      "contentType": "image/png",
      "camera": 1,
      "timestamp": 1730750160846
    }
  }
  ```

- `upload_complete`

  ```jsonc
  {
    "type": "upload_complete",
    "requestId": "uuid",
    "payload": {
      "scan": "H10011",
      "fileName": "H10011_CAM1_20251104.png",
      "key": "uploads/H10011_CAM1_20251104.png",
      "contentType": "image/png",
      "camera": 1,
      "timestamp": 1730750160846,
      "finalUrl": "https://hwab-photo.s3.us-west-2.amazonaws.com/uploads/H10011_CAM1_20251104.png"
    }
  }
  ```

- `analyze_request` — identical payload to `upload_complete`; use for manual re-runs.

### Server → Client messages

- `presign_response` — contains the form upload target (`url`, `fields`, `key`, `finalUrl`, `expiresIn`).
- `analysis_result` — returns the normalized DynamoDB record produced by `analyzeAndStore`.
- `status` — heartbeat updates (`presign.started`, `analysis.ai.request`, `analysis.db.success`, etc.) with `scan`, optional `fileName`, human-readable `message`, and ISO timestamp.
- `snapshot` — replay of the most recent status events when a client connects or reconnects.
- `error` — request-scoped failure with an explanatory message.

Clients should queue outgoing messages until the socket reports `ready`, retry pending work after reconnect, and surface `status` updates in the UI so users always know which stage a scan is in.

## Environment variables

- `PORT` — HTTP port to bind (default `4000`)
- `AWS_REGION` — AWS region hosting your S3 bucket
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` — standard AWS credentials (can be omitted when using IAM roles)
- `S3_BUCKET_NAME` — bucket that will store uploaded images
- `S3_KEY_PREFIX` — optional folder prefix (e.g. `uploads/`)
- `S3_PRESIGN_TTL` — seconds the pre-signed request stays valid (max `900`)
- `ALLOWED_ORIGINS` — comma-separated list of allowed CORS origins
- `MAX_UPLOAD_BYTES` — maximum upload size, defaults to 5 MB
- `OPENAI_API_KEY` — OpenAI API key used for image analysis
- `OPENAI_MODEL` — optional model override (defaults to `gpt-4.1-mini`)
- `DYNAMODB_TABLE` (or legacy `DYNAMO_TABLE_NAME`) — DynamoDB table used to persist results (`id`/`scanId` is the partition key)

## HWAB Inventory Data Model

The backend normalizes every scan into a predictable DynamoDB shape so multiple images can safely build a single record. This section is the source of truth for that schema.

### Philosophy

1. **Description vs Observation** — canonical facts about the car live separately from scene observations.
2. **Stable structure** — every item has the same keys; unknown values are filled with the placeholder `"UNKNOWN"` instead of being omitted.
3. **Human overrides** — machine guesses include confidence/source metadata so curators can correct them without losing information.
4. **Raw data preserved** — model output is kept under `extra.raw_*` for future training while the main document stays clean.
5. **Queryable** — key attributes (e.g. UPC, series, subset number) are indexed for warehouse operations.

### Table & Indexes

- **Table:** `hwab-inventory`
- **Partition key:** `id` (string, usually the scan/box ID)
- **Recommended GSIs:**
  - `GSI_UPC` — PK: `codes.upc`, SK: `id`
  - `GSI_SERIES_SUBSET` — PK: `item.series`, SK: `packaging.subset_number`

### Canonical Item Skeleton

Every record the backend writes follows this structure (all fields always exist):

```jsonc
{
  "id": "",
  "item": {
    "line": "",
    "series": "",
    "model": "",
    "description": ""
  },
  "packaging": {
    "global_assortment_number": "",
    "subset_number": "",
    "guarantee_badge": "",
    "card_front_logo": ""
  },
  "codes": {
    "upc": "",
    "assortment": "",
    "internal_code": "",
    "batch_code": "",
    "country_of_origin": "",
    "region": ""
  },
  "branding": {
    "brand": "",
    "websites": []
  },
  "compliance": {
    "age_warning": "",
    "standards": [],
    "recycling": "",
    "warranty": "",
    "warnings": []
  },
  "vehicle": {
    "make": "",
    "base_model": "",
    "condition": ""
  },
  "visual": {
    "body_color_primary": {
      "norm": "",
      "raw": "",
      "confidence": 0,
      "source": ""
    },
    "body_color_secondary": [],
    "graphics": {
      "style": "",
      "text_elements": [],
      "locations": []
    },
    "wheels": {
      "style": "",
      "rim_color": "",
      "tire_color": "",
      "notes": ""
    }
  },
  "inventory": {
    "location": "",
    "status": "",
    "owner": ""
  },
  "ocr": {
    "raw_text": [],
    "entities": []
  },
  "media": [
    {
      "side": "",
      "file_name": "",
      "s3_key": "",
      "content_type": "",
      "captured_at": "",
      "source_model": "",
      "confidence": 0
    }
  ],
  "scan": {
    "scan_id": "",
    "request_id": "",
    "scanned_at": ""
  },
  "extra": {
    "raw_front": {},
    "raw_back": {},
    "raw_other": {},
    "raw_response": {}
  },
  "meta": {
    "schema_version": 1,
    "created_at": "",
    "updated_at": ""
  }
}
```

### Ingest & Update Rules

1. **Skeleton first** — every scan starts from the skeleton above so keys always exist.
2. **Idempotent merge** — repeated scans of the same `id` pull the existing item, merge in new observations, and append media instead of overwriting.
3. **Observation parsing** — OpenAI output is harvested for:
   - series / model / line
   - UPC, assortment and batch codes
   - compliance badges and warnings
   - vehicle descriptors and colors
   - raw text + entity annotations
4. **Media aggregation** — each successful upload adds one entry to `media` (deduped by S3 key) and stores structured raw output under `extra.raw_front` / `raw_back` based on camera ID.
5. **Placeholders** — missing strings are set to `"UNKNOWN"`, lists default to `[]`, objects default to `{}`.
6. **Timestamps** — `meta.created_at` is preserved, `meta.updated_at` is set on every ingest, and `scan.scanned_at` reflects the capture time (ISO 8601 UTC).
7. **Raw preservation** — the raw OpenAI response is stored in `extra.raw_response` so future ML training can replay the decision.

### Example Item

The Subaru BRZ card ends up looking like:

```jsonc
{
  "id": "H10011",
  "item": {
    "line": "Hot Wheels",
    "series": "J-IMPORTS",
    "model": "Subaru BRZ",
    "description": "Hot Wheels 1:64 Subaru BRZ in import racing livery, sealed on card."
  },
  "packaging": {
    "global_assortment_number": "48/250",
    "subset_number": "3/5",
    "guarantee_badge": "GUARANTEED FOR LIFE",
    "card_front_logo": "HOT WHEELS"
  },
  "codes": {
    "upc": "194735256921",
    "assortment": "L2593",
    "internal_code": "JBB55-N9COL G1",
    "batch_code": "JBB55-N9COL G1",
    "country_of_origin": "MALAYSIA",
    "region": "US ONLY"
  },
  "branding": {
    "brand": "Mattel",
    "websites": ["HOTWHEELS.COM", "SERVICE.MATTEL.COM"]
  },
  "compliance": {
    "age_warning": "Not suitable for children under 36 months. Small parts may be generated.",
    "standards": ["ASTM F963", "CE", "UKCA"],
    "recycling": "Check locally; remove from card",
    "warranty": "LIMITED LIFETIME WARRANTY SEE BACK FOR DETAILS",
    "warnings": []
  },
  "vehicle": {
    "make": "Subaru",
    "base_model": "BRZ",
    "condition": "mint/new in package"
  },
  "visual": {
    "body_color_primary": {
      "norm": "white",
      "raw": "#FFFFFF",
      "confidence": 0.82,
      "source": "gpt-5"
    },
    "body_color_secondary": ["blue", "red", "black"],
    "graphics": {
      "style": "racing / import",
      "text_elements": ["SUBARU"],
      "locations": ["hood", "doors", "sides"]
    },
    "wheels": {
      "style": "5-spoke",
      "rim_color": "chrome/silver",
      "tire_color": "black",
      "notes": "standard HW sport wheel"
    }
  },
  "inventory": {
    "location": "IGNIS_BILLY2_A12",
    "status": "stored",
    "owner": "UNKNOWN"
  },
  "ocr": {
    "raw_text": [
      "HOT WHEELS",
      "GUARANTEED FOR LIFE",
      "48/250",
      "3/5",
      "SUBARU",
      "J-IMPORTS",
      "SUBARU BRZ",
      "194735256921"
    ],
    "entities": [
      { "category": "brand/logo", "text": "HOT WHEELS", "confidence": 0.99, "side": "front" },
      { "category": "assortment/collection", "text": "48/250", "confidence": 0.93, "side": "front" },
      { "category": "subset", "text": "3/5", "confidence": 0.95, "side": "front" },
      { "category": "vehicle make", "text": "SUBARU", "confidence": 0.98, "side": "front" },
      { "category": "series/line", "text": "J-IMPORTS", "confidence": 0.99, "side": "back" },
      { "category": "model", "text": "Subaru BRZ", "confidence": 0.99, "side": "back" },
      { "category": "UPC", "text": "194735256921", "confidence": 0.95, "side": "back" }
    ]
  },
  "media": [
    {
      "side": "front",
      "file_name": "H10011_CAM1_20251104203420081.png",
      "s3_key": "uploads/H10011_CAM1_20251104203420081.png",
      "content_type": "image/png",
      "captured_at": "2025-11-04T20:34:21.000Z",
      "source_model": "gpt-5",
      "confidence": 0
    },
    {
      "side": "back",
      "file_name": "H10011_CAM2_20251104202404180.png",
      "s3_key": "uploads/H10011_CAM2_20251104202404180.png",
      "content_type": "image/png",
      "captured_at": "2025-11-04T20:24:05.000Z",
      "source_model": "gpt-5",
      "confidence": 0
    }
  ],
  "scan": {
    "scan_id": "H10011",
    "request_id": "2aff9bcd",
    "scanned_at": "2025-11-04T20:35:40.846Z"
  },
  "extra": {
    "raw_front": { "detected_text": [] },
    "raw_back": { "detected_text": [] },
    "raw_other": {},
    "raw_response": {}
  },
  "meta": {
    "schema_version": 1,
    "created_at": "2025-11-04T20:35:40.846Z",
    "updated_at": "2025-11-04T20:35:40.846Z"
  }
}
```

Keep this document alongside the code when evolving the pipeline so future updates stay compatible with existing inventory data.
