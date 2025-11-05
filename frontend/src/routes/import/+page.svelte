<script>
	import { onMount, onDestroy } from 'svelte';
	import { scanner, scancount } from '$lib/stores/scanner';
	import {
		sendRequest,
		subscribeStatus,
		subscribeSnapshot,
		wsConnection,
		connect as ensureWebSocket
	} from '$lib/wsClient';
	import { recognizeCanvas, terminateVisionWorker } from '$lib/vision/tesseractWorker';

	let cameras = [];
	let hist = [];
	let devices = [];
	let cameraError = null;

	const VISION_DELAY_MS = 200;
	const VISION_HIGHLIGHT_MS = 100;
	const MIN_CONFIDENCE = 60;
	const UPSCALE_MIN_WIDTH = 96;
	const UPSCALE_MIN_HEIGHT = 48;

	const createVisionBuffers = () => {
		if (typeof document === 'undefined') {
			return {
				frameCanvas: null,
				frameCtx: null,
				cropCanvas: null,
				cropCtx: null
			};
		}

		const frameCanvas = document.createElement('canvas');
		const cropCanvas = document.createElement('canvas');

		return {
			frameCanvas,
			frameCtx: frameCanvas.getContext('2d', { willReadFrequently: true }),
			cropCanvas,
			cropCtx: cropCanvas.getContext('2d', { willReadFrequently: true })
		};
	};

	const createVisionState = (name = 'Vision Region') => ({
		enabled: false,
		name,
		region: {
			x: 0,
			y: 0,
			width: 640,
			height: 200
		},
		lastText: '',
		lastUpdated: 0,
		error: null,
		highlightActive: false,
		highlightToken: null,
		lastPreview: '',
	processing: {
		contrast: 1.8,
		threshold: 160,
		sharpen: 0.2
	},
	lastConfidence: 0,
	history: [],
	bestGuess: '',
	historyConfidence: 0,
	loopPromise: null,
	cancelLoop: false,
	frameWidth: 0,
	frameHeight: 0,
	buffers: createVisionBuffers()
	});

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const now = () =>
		typeof performance !== 'undefined' && typeof performance.now === 'function'
			? performance.now()
			: Date.now();

	const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

	const applyVisionEnhancements = (ctx, width, height, options = {}) => {
		if (!ctx) return;
		const { contrast = 1, threshold, sharpen = 0 } = options;
		let workingCtx = ctx;
		let workingWidth = width;
		let workingHeight = height;

		if (width < UPSCALE_MIN_WIDTH || height < UPSCALE_MIN_HEIGHT) {
			const scaleX = Math.max(2, Math.ceil(UPSCALE_MIN_WIDTH / Math.max(width, 1)));
			const scaleY = Math.max(2, Math.ceil(UPSCALE_MIN_HEIGHT / Math.max(height, 1)));
			const scaleFactor = Math.max(scaleX, scaleY);
			const baseCanvas = document.createElement('canvas');
			baseCanvas.width = width;
			baseCanvas.height = height;
			const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
			if (baseCtx) {
				baseCtx.drawImage(ctx.canvas, 0, 0);
				ctx.canvas.width = width * scaleFactor;
				ctx.canvas.height = height * scaleFactor;
				workingCtx = ctx.canvas.getContext('2d', { willReadFrequently: true });
				if (workingCtx) {
					workingCtx.imageSmoothingEnabled = false;
					workingCtx.drawImage(baseCanvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
					workingWidth = ctx.canvas.width;
					workingHeight = ctx.canvas.height;
				}
			}
		}

		if (!workingCtx) return;

		const imageData = workingCtx.getImageData(0, 0, workingWidth, workingHeight);
		const { data } = imageData;
		const contrastValue = Number.isFinite(contrast) ? contrast : 1;
		const thresholdNumeric =
			typeof threshold === 'number'
				? threshold
				: typeof threshold === 'string' && threshold.trim() !== ''
					? Number(threshold)
					: null;
		const thresholdValue =
			thresholdNumeric !== null && Number.isFinite(thresholdNumeric)
				? clampNumber(thresholdNumeric, 0, 255)
				: null;

		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];

			let gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			gray = (gray - 128) * contrastValue + 128;
			gray = clampNumber(gray, 0, 255);

			if (thresholdValue !== null) {
				gray = gray >= thresholdValue ? 255 : 0;
			}

			data[i] = gray;
			data[i + 1] = gray;
			data[i + 2] = gray;
		}

		workingCtx.putImageData(imageData, 0, 0);

		const sharpenAmount = Number.isFinite(sharpen) ? clampNumber(sharpen, 0, 1) : 0;
		if (sharpenAmount > 0) {
			const kernel = [
				0,
				-1 * sharpenAmount,
				0,
				-1 * sharpenAmount,
				1 + 4 * sharpenAmount,
				-1 * sharpenAmount,
				0,
				-1 * sharpenAmount,
				0
			];

			const input = workingCtx.getImageData(0, 0, workingWidth, workingHeight);
			const output = workingCtx.createImageData(workingWidth, workingHeight);
			const src = input.data;
			const dst = output.data;

			for (let y = 0; y < workingHeight; y += 1) {
				for (let x = 0; x < workingWidth; x += 1) {
					let sum = 0;

					for (let ky = -1; ky <= 1; ky += 1) {
						for (let kx = -1; kx <= 1; kx += 1) {
							const iy = clampNumber(y + ky, 0, workingHeight - 1);
							const ix = clampNumber(x + kx, 0, workingWidth - 1);
							const srcIndex = (iy * workingWidth + ix) * 4;
							const weight = kernel[(ky + 1) * 3 + (kx + 1)];
							sum += src[srcIndex] * weight;
						}
					}

					const dstIndex = (y * workingWidth + x) * 4;
					const value = clampNumber(sum, 0, 255);
					dst[dstIndex] = value;
					dst[dstIndex + 1] = value;
					dst[dstIndex + 2] = value;
					dst[dstIndex + 3] = 255;
				}
			}

			workingCtx.putImageData(output, 0, 0);
		}
	};

	let last = 0;
	const MAX_HISTORY = 10;
	let connection = { connected: false, connecting: true, attempts: 0, lastError: null };
	let connectionUnsubscribe = () => {};
	let statusUnsubscribe = () => {};
	let snapshotUnsubscribe = () => {};

	const sanitizeForFilename = (value) => {
		if (!value) return '';
		return value
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toUpperCase();
	};

	const addEvent = (list = [], event) => {
		if (!event?.timestamp) return list;
		const exists = list.some(
			(existing) => existing.timestamp === event.timestamp && existing.event === event.event
		);
		return exists ? list : [...list, event];
	};

	const formatTimestamp = (iso) => {
		if (!iso) return '';
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return iso;
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	};

	const getFrameSize = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision) return null;

		if (vision.frameWidth && vision.frameHeight) {
			return {
				frameWidth: vision.frameWidth,
				frameHeight: vision.frameHeight
			};
		}

		const video = cameraObj?.videoEl;
		if (!video || !video.videoWidth || !video.videoHeight) return null;

		const rotation = cameraObj.rotation ?? 0;
		return rotation % 180 === 0
			? { frameWidth: video.videoWidth, frameHeight: video.videoHeight }
			: { frameWidth: video.videoHeight, frameHeight: video.videoWidth };
	};

	const clampPercent = (value) => Math.max(0, Math.min(100, value));

	const getVisionRectStyle = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision?.enabled) return '';

		const dims = getFrameSize(cameraObj);
		if (!dims) return '';

		const { region } = vision;
		if (!region) return '';

		const left = clampPercent((region.x / dims.frameWidth) * 100);
		const top = clampPercent((region.y / dims.frameHeight) * 100);
		const width = Math.max(0, Math.min((region.width / dims.frameWidth) * 100, 100 - left));
		const height = Math.max(0, Math.min((region.height / dims.frameHeight) * 100, 100 - top));

		return `left:${left}%;top:${top}%;width:${width}%;height:${height}%;`;
	};

	const getVisionTextStyle = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision?.enabled) return '';

		const dims = getFrameSize(cameraObj);
		if (!dims) return '';

		const { region } = vision;
		if (!region) return '';

		const left = clampPercent((region.x / dims.frameWidth) * 100);
		const textTop = clampPercent(((region.y + region.height) / dims.frameHeight) * 100 + 2);
		const width = Math.max(0, Math.min((region.width / dims.frameWidth) * 100, 100 - left));

		return `left:${left}%;top:${textTop}%;width:${width}%;`;
	};

	const extractVisionRegion = async (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision?.enabled) return null;

		const { buffers } = vision;
		const video = cameraObj.videoEl;

		if (
			!buffers?.frameCanvas ||
			!buffers?.frameCtx ||
			!buffers?.cropCanvas ||
			!buffers?.cropCtx ||
			!video ||
			!video.videoWidth ||
			!video.videoHeight
		) {
			return null;
		}

		const rotation = cameraObj.rotation ?? 0;
		const frameWidth = rotation % 180 === 0 ? video.videoWidth : video.videoHeight;
		const frameHeight = rotation % 180 === 0 ? video.videoHeight : video.videoWidth;

		const prevWidth = vision.frameWidth;
		const prevHeight = vision.frameHeight;
		const dimensionChanged = prevWidth !== frameWidth || prevHeight !== frameHeight;

		vision.frameWidth = frameWidth;
		vision.frameHeight = frameHeight;

		const { frameCanvas, frameCtx, cropCanvas, cropCtx } = buffers;
		frameCanvas.width = frameWidth;
		frameCanvas.height = frameHeight;
		frameCtx.setTransform(1, 0, 0, 1, 0, 0);
		frameCtx.clearRect(0, 0, frameWidth, frameHeight);
		frameCtx.save();
		frameCtx.translate(frameWidth / 2, frameHeight / 2);
		frameCtx.rotate((rotation * Math.PI) / 180);
		frameCtx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
		frameCtx.restore();

		const { x, y, width, height } = vision.region;
		const prevError = vision.error;

		if (width <= 0 || height <= 0) {
			const message = 'Vision region size must be greater than zero';
			vision.error = message;
			return {
				dataUrl: null,
				dimensionChanged,
				errorChanged: prevError !== message
			};
		}

		if (x < 0 || y < 0 || x + width > frameWidth || y + height > frameHeight) {
			const message = 'Vision region out of bounds';
			vision.error = message;
			return {
				dataUrl: null,
				dimensionChanged,
				errorChanged: prevError !== message
			};
		}

		vision.error = null;
		const errorChanged = Boolean(prevError);

		cropCanvas.width = width;
		cropCanvas.height = height;
		cropCtx.setTransform(1, 0, 0, 1, 0, 0);
		cropCtx.clearRect(0, 0, width, height);
		cropCtx.drawImage(frameCanvas, x, y, width, height, 0, 0, width, height);

		applyVisionEnhancements(cropCtx, width, height, vision.processing ?? {});

		let dataUrl = '';
		try {
			dataUrl = cropCanvas.toDataURL('image/png');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to export vision region';
			vision.error = message;
			return {
				dataUrl: null,
				dimensionChanged,
				errorChanged: true
			};
		}

		const previewChanged = vision.lastPreview !== dataUrl;
		vision.lastPreview = dataUrl;

		return {
			dataUrl,
			dimensionChanged,
			errorChanged,
			previewChanged
		};
	};

	const startVisionLoop = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision || vision.loopPromise || !vision.enabled) return;
		if (!cameraObj.active || !cameraObj.videoEl) return;

		vision.cancelLoop = false;
		vision.loopPromise = (async () => {
			while (!vision.cancelLoop && vision.enabled && cameraObj.active && cameraObj.videoEl) {
				const iterationStart = now();
				let shouldUpdate = false;

				const extracted = await extractVisionRegion(cameraObj);
				const visionDataUrl = extracted?.dataUrl ?? null;
				if (extracted?.dimensionChanged || extracted?.errorChanged || extracted?.previewChanged) {
					shouldUpdate = true;
				}

				if (visionDataUrl) {
					if (vision.highlightActive) {
						vision.highlightActive = false;
						shouldUpdate = true;
					}

					const highlightToken = Symbol('vision-highlight');
					const highlightStart = now();
					vision.highlightToken = highlightToken;
					if (!vision.highlightActive) {
						vision.highlightActive = true;
						cameras = [...cameras];
					}

					const clearHighlight = () => {
						const targetVision = cameraObj?.vision;
						if (!targetVision || targetVision.highlightToken !== highlightToken) {
							return;
						}
						if (!targetVision.highlightActive) return;
						targetVision.highlightActive = false;
						cameras = [...cameras];
					};

					try {
						const { text, confidence } = await recognizeCanvas(visionDataUrl);
						const raw = typeof text === 'string' ? text : '';
						const cleaned = raw.replace(/\s+/g, ' ').trim();
						const confValue = Number.isFinite(confidence) ? confidence : 0;
						if (vision.lastConfidence !== confValue) {
							vision.lastConfidence = confValue;
							shouldUpdate = true;
						}

						const candidateMatches = cleaned === vision.candidateText;
						const candidateCount = candidateMatches ? vision.candidateCount + 1 : 1;
						vision.candidateText = cleaned;
						vision.candidateCount = candidateCount;

						const meetsConfidence = confValue >= MIN_CONFIDENCE;
						const growsText =
							cleaned &&
							vision.lastText &&
							cleaned.length > vision.lastText.length &&
							cleaned.includes(vision.lastText);
						const repeated = candidateCount >= 2;
						const shouldPublish = cleaned
							? meetsConfidence || growsText || repeated
							: candidateCount >= 3;

						if (shouldPublish) {
							if (vision.lastText !== cleaned) {
								vision.lastText = cleaned;
								shouldUpdate = true;
							}
							vision.lastUpdated = Date.now();
						}

						vision.error = null;
					} catch (err) {
						const message = err instanceof Error ? err.message : 'Vision error';
						if (vision.error !== message) {
							vision.error = message;
							shouldUpdate = true;
						}
						vision.candidateText = '';
						vision.candidateCount = 0;
					}

					const elapsedHighlight = now() - highlightStart;
					if (elapsedHighlight >= VISION_HIGHLIGHT_MS) {
						clearHighlight();
					} else {
						setTimeout(clearHighlight, VISION_HIGHLIGHT_MS - elapsedHighlight);
					}
				}

				if (shouldUpdate) {
					cameras = [...cameras];
				}

				const elapsed = now() - iterationStart;
				const delay = Math.max(VISION_DELAY_MS - elapsed, 0);
				if (delay > 0) {
					await sleep(delay);
				}
			}
		})().finally(() => {
			vision.loopPromise = null;
			vision.cancelLoop = false;
			vision.highlightToken = null;
			if (vision.highlightActive) {
				vision.highlightActive = false;
				cameras = [...cameras];
			}
		});
	};

	const stopVisionLoop = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision) return;
		vision.cancelLoop = true;
		vision.highlightToken = null;
		if (vision.highlightActive) {
			vision.highlightActive = false;
			cameras = [...cameras];
		}
	};

	const ensureVisionLoop = (cameraObj) => {
		const vision = cameraObj?.vision;
		if (!vision) return;

		if (vision.enabled && cameraObj.active && cameraObj.videoEl) {
			startVisionLoop(cameraObj);
		} else if (!vision.enabled || !cameraObj.active) {
			stopVisionLoop(cameraObj);
		}
	};

	const handleVisionToggle = (cameraObj, enabled) => {
	if (!cameraObj?.vision) return;
	cameraObj.vision.enabled = enabled;
	cameraObj.vision.lastUpdated = 0;
	cameraObj.vision.lastText = '';
	cameraObj.vision.error = null;
	cameraObj.vision.highlightActive = false;
	cameraObj.vision.highlightToken = null;
	if (!enabled) {
		cameraObj.vision.lastPreview = '';
	}
	cameraObj.vision.history = [];
	cameraObj.vision.bestGuess = '';
	cameraObj.vision.historyConfidence = 0;
	cameraObj.vision.lastConfidence = 0;

	if (!enabled) {
			stopVisionLoop(cameraObj);
		} else {
			startVisionLoop(cameraObj);
		}

		cameras = [...cameras];
	};

	const updateVisionField = (cameraObj, field, value) => {
		if (!cameraObj?.vision?.region) return;
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return;
		const minValue = field === 'width' || field === 'height' ? 1 : 0;
		cameraObj.vision.region[field] = Math.max(minValue, Math.round(numeric));
		cameraObj.vision.lastUpdated = 0;
		cameraObj.vision.error = null;
		cameras = [...cameras];
	};

	const updateVisionName = (cameraObj, value) => {
		if (!cameraObj?.vision) return;
		cameraObj.vision.name = value;
		cameras = [...cameras];
	};

	const updateVisionProcessingField = (cameraObj, field, value) => {
		if (!cameraObj?.vision) return;
		const processing = cameraObj.vision.processing ?? {};
		let nextValue = processing[field];

		if (field === 'contrast') {
			const numeric = Number(value);
			if (!Number.isFinite(numeric)) return;
			nextValue = Number(numeric.toFixed(2));
			nextValue = clampNumber(nextValue, 0, 5);
		} else if (field === 'threshold') {
			if (value === '' || value === null || value === undefined) {
				nextValue = null;
			} else {
				const numeric = Number(value);
				if (!Number.isFinite(numeric)) return;
				nextValue = clampNumber(Math.round(numeric), 0, 255);
			}
		} else if (field === 'sharpen') {
			const numeric = Number(value);
			if (!Number.isFinite(numeric)) return;
			nextValue = Number(numeric.toFixed(2));
			nextValue = clampNumber(nextValue, 0, 1);
		} else {
			return;
		}

		cameraObj.vision.processing = {
			...processing,
			[field]: nextValue
		};
		cameraObj.vision.lastPreview = '';
		cameraObj.vision.history = [];
		cameraObj.vision.bestGuess = '';
		cameraObj.vision.historyConfidence = 0;
		cameras = [...cameras];
	};

	const onVideoReady = (cameraObj) => {
		ensureVisionLoop(cameraObj);
	};

	const handleStatus = (status) => {
		const { scan, fileName, message, event, timestamp, data } = status ?? {};
		if (!scan) return;
		const entry = hist.find((item) => item.scan === scan);
		if (!entry) return;

		const eventRecord = {
			event,
			message,
			timestamp,
			data: data ?? {}
		};

		entry.events = addEvent(entry.events ?? [], eventRecord);

		if (fileName) {
			const upload = entry.uploads.find((u) => u.fileName === fileName);
			if (upload) {
				upload.statusMessages = addEvent(upload.statusMessages ?? [], eventRecord);
				upload.lastStatus = message || event;
				if (event === 'analysis.completed') {
					upload.status = 'success';
					upload.error = null;
				} else if (event === 'analysis.queued') {
					upload.status = 'analyzing';
				} else if (event && event.includes('error')) {
					upload.status = 'error';
					upload.error = message ?? event;
				}
			}
		}

		if (event === 'analysis.completed') {
			entry.status = 'success';
			entry.error = null;
		}

		if (event && event.includes('error')) {
			entry.status = 'error';
			entry.error = message ?? event;
		}

		hist = [...hist];
	};
	$: if ($scancount !== last) {
		last = $scancount;
		scanEvent();
	}

	const scanEvent = () => {
		const scanValue = $scanner?.trim();
		if (!scanValue) return;

		const images = cameras
			.filter((c) => c.active && c.videoEl)
			.map((c) => captureImage(c.videoEl, c.rotation))
			.filter(Boolean);

		const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '');
		const baseName = sanitizeForFilename(scanValue) || 'BARCODE';
		const uploads = images.map((dataUrl, idx) => ({
			camera: idx + 1,
			preview: dataUrl,
			fileName: `${baseName}_CAM${idx + 1}_${timestamp}.png`,
			status: 'pending',
			error: null,
			url: null,
			analysis: null,
			analysisError: null,
			statusMessages: [],
			lastStatus: ''
		}));

		const entry = {
			scan: scanValue,
			c: $scancount,
			status: uploads.length ? 'pending' : 'error',
			uploads,
			error: uploads.length ? null : 'No active camera images available',
			createdAt: Date.now(),
			events: []
		};

		hist = [...hist.slice(-(MAX_HISTORY - 1)), entry];
		if (!uploads.length) {
			hist = [...hist];
			return;
		}
		uploadScan(entry);
	};

	const uploadScan = async (entry) => {
		if (!entry.uploads.length) {
			entry.status = 'error';
			entry.error = 'No camera images available for upload';
			hist = [...hist];
			return;
		}

		entry.status = 'uploading';
		entry.error = null;
		hist = [...hist];

		await Promise.all(
			entry.uploads.map(async (upload) => {
				if (!upload.preview) {
					upload.status = 'error';
					upload.error = 'Missing image data';
					return;
				}

				const blob = dataUrlToBlob(upload.preview);
				if (!blob) {
					upload.status = 'error';
					upload.error = 'Unable to process captured image';
					return;
				}

				upload.status = 'uploading';
				upload.error = null;
				hist = [...hist];

				try {
					const presignResponse = await sendRequest('presign_request', {
						scan: entry.scan,
						fileName: upload.fileName,
						contentType: blob.type,
						camera: upload.camera,
						timestamp: entry.createdAt
					});

					const payload = presignResponse.data;
					if (!payload) {
						throw new Error('Presign response missing payload');
					}
					const s3Key = payload.key ?? payload?.fields?.key;
					if (!s3Key) {
						throw new Error('Upload payload missing S3 object key');
					}

					upload.url = await performS3Upload(payload, blob, upload);
					upload.status = 'analyzing';
					upload.error = null;
					hist = [...hist];

					const analysisResponse = await sendRequest('upload_complete', {
						scan: entry.scan,
						key: s3Key,
						contentType: blob.type,
						camera: upload.camera,
						timestamp: entry.createdAt,
						fileName: upload.fileName,
						extra: {
							finalUrl: upload.url
						}
					});

					const analysisResult = pruneUploadMeta(analysisResponse.data);

					upload.status = 'success';
					upload.error = null;
					upload.analysis = analysisResult;
					upload.analysisError = null;
				} catch (err) {
					console.error('Upload pipeline error', err);
					upload.status = 'error';
					const message = err instanceof Error ? err.message : 'Upload failed';
					upload.error = message;
					upload.analysisError = message;
					handleStatus({
						scan: entry.scan,
						fileName: upload.fileName,
						event: 'client.error',
						message,
						timestamp: new Date().toISOString(),
						data: {}
					});
				} finally {
					hist = [...hist];
				}
			})
		);

		updateEntryStatus(entry);
		hist = [...hist];
	};

	const dataUrlToBlob = (dataUrl) => {
		if (!dataUrl?.startsWith('data:')) return null;
		const [meta, base64] = dataUrl.split(',');
		if (!meta || !base64) return null;
		const mimeMatch = meta.match(/data:(.*?);base64/);
		const mime = mimeMatch ? mimeMatch[1] : 'image/png';
		const binary = atob(base64);
		const len = binary.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new Blob([bytes], { type: mime });
	};

	const updateEntryStatus = (entry) => {
		if (!entry.uploads.length) {
			entry.status = 'error';
			return;
		}

		if (entry.uploads.some((u) => u.status === 'error')) {
			entry.status = 'error';
			entry.error = entry.uploads.find((u) => u.status === 'error')?.error ?? 'Upload failed';
			return;
		}

		if (entry.uploads.every((u) => u.status === 'success')) {
			entry.status = 'success';
			entry.error = null;
			return;
		}

		if (entry.uploads.some((u) => u.status === 'uploading' || u.status === 'analyzing')) {
			entry.status = 'uploading';
		} else {
			entry.status = 'pending';
		}
	};

	const performS3Upload = async (payload, blob, upload) => {
		if (!payload) throw new Error('Upload endpoint returned no payload');

		// Support POST form uploads (common for S3) and simple PUT pre-signed URLs.
		if (payload.url && payload.fields) {
			const formData = new FormData();
			Object.entries(payload.fields).forEach(([key, value]) => {
				formData.append(key, value);
			});
			formData.append('file', blob, upload.fileName);

			const response = await fetch(payload.url, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				const message = (await response.text()) || response.statusText;
				throw new Error(message);
			}

			return payload.finalUrl ?? `${payload.url}/${payload.fields.key}`;
		}

		if (payload.url) {
			const method = payload.method ?? 'PUT';
			const headers = payload.headers ?? {};
			if (!headers['Content-Type']) {
				headers['Content-Type'] = blob.type;
			}

			const response = await fetch(payload.url, {
				method,
				headers,
				body: blob
			});

			if (!response.ok) {
				const message = (await response.text()) || response.statusText;
				throw new Error(message);
			}

			return payload.finalUrl ?? payload.url.split('?')[0];
		}

		throw new Error('Upload payload missing URL information');
	};

	const pruneUploadMeta = (analysisResult) => {
		if (!analysisResult || typeof analysisResult !== 'object') return analysisResult;
		if (Array.isArray(analysisResult)) {
			return analysisResult.map(pruneUploadMeta);
		}

		if (analysisResult.record && typeof analysisResult.record === 'object') {
			return {
				...analysisResult,
				record: pruneUploadMeta(analysisResult.record)
			};
		}

		const cleaned = { ...analysisResult };
		if (cleaned.metadata) {
			const { metadata } = cleaned;
			cleaned.metadata = {
				...metadata,
				extra: metadata.extra?.fileName
					? {
							fileName: metadata.extra.fileName,
							finalUrl: metadata.extra.finalUrl
						}
					: metadata.extra
			};
		}
		return cleaned;
	};

	const rotateCamera = (cameraObj) => {
		cameraObj.rotation = (cameraObj.rotation + 90) % 360;
		cameras = [...cameras]; // Trigger reactivity
	};

	const startCamera = async (cameraObj, w = 3840, h = 2160) => {
		if (cameraObj.active) return;

		// Swap width and height if in portrait mode
		if (!cameraObj.landscape) {
			[w, h] = [h, w]; // cleaner swap
		}

		try {
			cameraObj.stream = await navigator.mediaDevices.getUserMedia({
				video: {
					deviceId: { exact: cameraObj.device.deviceId },
					width: { ideal: w },
					height: { ideal: h }
				},
				audio: false
			});
			cameraObj.active = true;
			cameraObj.error = null;
			cameras = [...cameras]; // trigger Svelte reactivity
			setTimeout(() => {
				if (!cameraObj.videoEl) return;
				cameraObj.videoEl.srcObject = cameraObj.stream;
				ensureVisionLoop(cameraObj);
			}, 10);
		} catch (err) {
			cameraObj.active = false;
			cameraObj.stream = null;
			cameraObj.error = err instanceof Error ? err.message : 'Unable to start camera';
			stopVisionLoop(cameraObj);
			cameras = [...cameras];
		}
	};

	const toggleCamera = async (cameraObj) => {
		cameraObj.active ? stopCamera(cameraObj) : startCamera(cameraObj);
		cameras = [...cameras]; // triggers reactive update
	};

	const stopCamera = (cameraObj) => {
		cameraObj.stream?.getTracks().forEach((t) => t.stop());
		cameraObj.stream = null;
		cameraObj.active = false;
		cameraObj.error = null;
		if (cameraObj.videoEl) cameraObj.videoEl.srcObject = null;
		stopVisionLoop(cameraObj);
	};

	const captureImage = (video, rotation = 0) => {
		if (!video) return null;

		const width = video.videoWidth;
		const height = video.videoHeight;

		const c = document.createElement('canvas');
		const ctx = c.getContext('2d');

		// Adjust canvas size based on rotation
		if (rotation % 180 === 0) {
			c.width = width;
			c.height = height;
		} else {
			c.width = height;
			c.height = width;
		}

		if (!ctx) return null;

		// Apply rotation and draw the image
		ctx.save();
		ctx.translate(c.width / 2, c.height / 2);
		ctx.rotate((rotation * Math.PI) / 180);
		ctx.drawImage(video, -width / 2, -height / 2);
		ctx.restore();

		return c.toDataURL('image/png');
	};

	onMount(async () => {
		ensureWebSocket();
		connectionUnsubscribe = wsConnection.subscribe((state) => {
			connection = state;
		});
		statusUnsubscribe = subscribeStatus(handleStatus);
		snapshotUnsubscribe = subscribeSnapshot((operations) => {
			operations.forEach((operation) => {
				(operation.events ?? []).forEach(handleStatus);
			});
		});

		hist = [];
		if (!navigator?.mediaDevices?.getUserMedia) {
			cameraError = 'Camera access is not supported in this browser.';
			return;
		}
		try {
			const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true });
			permissionStream?.getTracks().forEach((track) => track.stop());
			const allDevices = await navigator.mediaDevices.enumerateDevices();
			devices = allDevices.filter((d) => d.kind === 'videoinput');
			cameraError = null;
		} catch (err) {
			cameraError = err instanceof Error ? err.message : 'Unable to access camera';
			devices = [];
		}

		cameras = devices.map((d, idx) => ({
			device: d,
			stream: null,
			videoEl: null,
			active: false,
			rotation: 0,
			landscape: true,
			error: null,
			vision: createVisionState(`CAM${idx + 1} Vision`)
		}));
	});

	onDestroy(() => {
		cameras.forEach((c) => stopCamera(c));
		connectionUnsubscribe();
		statusUnsubscribe();
		snapshotUnsubscribe();
		terminateVisionWorker().catch(() => {});
	});
</script>

<section class="flex flex-col items-center gap-4 p-4">
	<div class="w-full flex justify-end text-xs text-white/80">
		{#if connection.connected}
			<span class="px-2 py-1 rounded bg-emerald-600/30">WebSocket connected</span>
		{:else if connection.connecting}
			<span class="px-2 py-1 rounded bg-orange-600/30">
				{connection.attempts ? `Reconnecting… (${connection.attempts})` : 'Connecting...'}
			</span>
		{:else}
			<span class="px-2 py-1 rounded bg-rose-600/30">Disconnected</span>
		{/if}
	</div>
	<!-- Toggle Buttons -->
	<div class="flex flex-wrap justify-center gap-2">
		{#each cameras as cam, index (index)}
			<button
				class="px-4 py-2 rounded shadow transition"
				class:bg-green-700={cam.active}
				class:bg-gray-800={!cam.active}
				class:text-white={true}
				class:outline={cam.error}
				class:outline-2={cam.error}
				class:outline-rose-500={cam.error}
				on:click={() => toggleCamera(cam)}
			>
				{cam.device.label || 'Unnamed Camera'}
				{cam.active ? '🟢' : '⚪'}
			</button>
		{/each}
	</div>

	{#if cameraError}
		<div class="text-sm text-rose-400">{cameraError}</div>
	{/if}

	<!-- Video Feeds -->
	<div class="flex items-center justify-between gap-4 p-4 text-lg rounded shadow">
		{#each cameras as cam, index (index)}
			{#if cam.active}
				<div class="flex flex-col items-center gap-2">
					<div
						class="relative inline-block transition-transform duration-300"
						style="transform: rotate({cam.rotation}deg); transform-origin: center;"
					>
						<!-- svelte-ignore a11y_media_has_caption -->
						<!-- svelte-ignore element_invalid_self_closing_tag -->
						<video
							bind:this={cam.videoEl}
							autoplay
							playsinline
							on:click={() => rotateCamera(cam)}
							on:loadedmetadata={() => onVideoReady(cam)}
							class="rounded shadow cursor-pointer block"
						/>
						{#if cam.vision.enabled}
							{#if getVisionRectStyle(cam)}
								<div
									class="absolute pointer-events-none border-2 transition-colors duration-100"
									class:border-green-500={cam.vision.highlightActive}
									class:border-red-500={!cam.vision.highlightActive}
									style={getVisionRectStyle(cam)}
								></div>
								<div
									class="absolute pointer-events-none bg-black/80 text-red-200 text-xs px-2 py-1 rounded translate-y-1 text-center"
									style={getVisionTextStyle(cam)}
								>
									Vision: {cam.vision.name || 'Region'} — {cam.vision.lastText || '…'}
								</div>
							{/if}
						{/if}
					</div>
					<div class="w-full max-w-xs text-xs text-white/80 space-y-2">
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								checked={cam.vision.enabled}
								on:change={(event) => handleVisionToggle(cam, event.currentTarget.checked)}
							/>
							Enable Vision
						</label>
						{#if cam.vision.enabled}
							<div class="grid grid-cols-2 gap-2">
								<label class="flex flex-col gap-1">
									<span>X</span>
									<input
										type="number"
										min="0"
										value={cam.vision.region.x}
										on:input={(event) => updateVisionField(cam, 'x', event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
								</label>
								<label class="flex flex-col gap-1">
									<span>Y</span>
									<input
										type="number"
										min="0"
										value={cam.vision.region.y}
										on:input={(event) => updateVisionField(cam, 'y', event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
								</label>
								<label class="flex flex-col gap-1">
									<span>Width</span>
									<input
										type="number"
										min="1"
										value={cam.vision.region.width}
										on:input={(event) => updateVisionField(cam, 'width', event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
								</label>
								<label class="flex flex-col gap-1">
									<span>Height</span>
									<input
										type="number"
										min="1"
										value={cam.vision.region.height}
										on:input={(event) =>
											updateVisionField(cam, 'height', event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
								</label>
								<label class="flex flex-col gap-1 col-span-2">
									<span>Name</span>
									<input
										type="text"
										value={cam.vision.name}
										on:input={(event) => updateVisionName(cam, event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
								</label>
							</div>
							<div class="grid grid-cols-2 gap-2">
								<label class="flex flex-col gap-1">
									<span>Contrast</span>
									<input
										type="range"
										min="0"
										max="4"
										step="0.1"
										value={cam.vision.processing?.contrast ?? 1}
										on:input={(event) =>
											updateVisionProcessingField(cam, 'contrast', event.currentTarget.value)}
									/>
									<span class="text-[10px] text-white/70">
										{(cam.vision.processing?.contrast ?? 1).toFixed(1)}×
									</span>
								</label>
								<label class="flex flex-col gap-1">
									<span>Threshold</span>
									<input
										type="number"
										min="0"
										max="255"
										step="1"
										value={cam.vision.processing?.threshold ?? ''}
										on:input={(event) =>
											updateVisionProcessingField(cam, 'threshold', event.currentTarget.value)}
										class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
									/>
									<span class="text-[10px] text-white/60">Leave blank to disable</span>
								</label>
								<label class="flex flex-col gap-1 col-span-2">
									<span>Sharpen</span>
									<input
										type="range"
										min="0"
										max="1"
										step="0.05"
										value={cam.vision.processing?.sharpen ?? 0}
										on:input={(event) =>
											updateVisionProcessingField(cam, 'sharpen', event.currentTarget.value)}
									/>
									<span class="text-[10px] text-white/70">
										{(cam.vision.processing?.sharpen ?? 0).toFixed(2)}
									</span>
								</label>
							</div>
							{#if cam.vision.lastPreview}
								<div class="flex flex-col gap-1">
									<span>Preview</span>
									<img
										src={cam.vision.lastPreview}
										alt={`Vision preview for ${cam.vision.name || 'Region'}`}
										class="rounded border border-emerald-400/40 bg-black/60 max-h-32 object-contain"
									/>
								</div>
							{/if}
							<div class="text-[10px] text-white/60">
								Confidence: {Math.round(cam.vision.lastConfidence ?? 0)}%
							</div>
							<div class="text-[11px] text-emerald-200/90">
								Vision: {cam.vision.name || 'Region'} — {cam.vision.lastText || '…'}
							</div>
							{#if cam.vision.error}
								<div class="text-[11px] text-rose-300">
									{cam.vision.error}
								</div>
							{/if}
						{/if}
					</div>
				</div>
			{:else if cam.error}
				<div class="text-sm text-rose-400 max-w-xs">{cam.error}</div>
			{/if}
		{/each}
	</div>

	<!-- Scan History -->
	{#if hist.length}
		<div class="w-full flex flex-col gap-2 mt-6">
			{#each [...hist].reverse() as entry (entry.c)}
				<div
					class="flex items-center opacity-70 justify-between gap-4 text-lg overflow-hidden overflow-x-scroll rounded-md"
					class:bg-emerald-300={entry.status === 'success'}
					class:bg-cyan-600={entry.status === 'pending' || entry.status === 'uploading'}
					class:bg-rose-400={entry.status === 'error'}
				>
					<!-- Scan overlay -->
					<div
						class="bg-cyan-900 bg-opacity-80 text-white text-sm px-4 py-1 overflow-scroll h-48 rounded-br z-10"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html entry.scan.split('').join('<br>')}
						<p class="mt-2 text-xs">
							{#if entry.status === 'pending'}
								Awaiting upload...
							{:else if entry.status === 'uploading'}
								{#if entry.uploads.some((u) => u.status === 'analyzing')}
									Analyzing...
								{:else}
									Uploading...
								{/if}
							{:else if entry.status === 'success'}
								Uploaded
							{:else}
								Upload failed{#if entry.error}: {entry.error}{/if}
							{/if}
						</p>
						{#if entry.events?.length}
							<div class="mt-2 text-[10px] space-y-1 max-h-24 overflow-y-auto pr-2">
								{#each entry.events as ev}
									<div>{formatTimestamp(ev.timestamp)} — {ev.message ?? ev.event}</div>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Images underneath -->
					{#each entry.uploads as upload, index (index)}
						<div class="flex flex-col items-center">
							<img src={upload.preview} alt="Capture {index + 1}" class="h-48 p-1 rounded" />
							<span class="text-xs text-white px-2">
								CAM{upload.camera}: {upload.status === 'success'
									? 'Uploaded'
									: upload.status === 'analyzing'
										? 'Analyzing...'
										: upload.status === 'uploading'
											? 'Uploading...'
											: upload.status === 'error'
												? `Error${upload.error ? `: ${upload.error}` : ''}`
												: 'Pending'}
							</span>
							{#if upload.lastStatus}
								<span class="text-[10px] text-white/70 px-2">{upload.lastStatus}</span>
							{/if}
							<span class="text-[10px] text-white/80 px-2">{upload.fileName}</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</section>
