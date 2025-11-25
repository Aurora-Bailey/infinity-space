/**
 * @typedef {object} VisionProcessing
 * @property {number} [contrast]
 * @property {number | null} [threshold]
 * @property {number} [sharpen]
 */

/**
 * @typedef {object} VisionRegion
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} VisionState
 * @property {boolean} enabled
 * @property {string} name
 * @property {VisionRegion} region
 * @property {string} lastText
 * @property {number} lastUpdated
 * @property {string | null} error
 * @property {boolean} highlightActive
 * @property {symbol | null} highlightToken
 * @property {string} lastPreview
 * @property {VisionProcessing} processing
 * @property {number} lastConfidence
 * @property {string[]} history
 * @property {string} bestGuess
 * @property {number} historyConfidence
 * @property {string} candidateText
 * @property {number} candidateCount
 * @property {Promise<void> | null} loopPromise
 * @property {boolean} cancelLoop
 * @property {number} frameWidth
 * @property {number} frameHeight
 * @property {{ frameCanvas: HTMLCanvasElement | null; frameCtx: CanvasRenderingContext2D | null; cropCanvas: HTMLCanvasElement | null; cropCtx: CanvasRenderingContext2D | null }} buffers
 */

const VISION_DELAY_MS = 200;
const VISION_HIGHLIGHT_MS = 100;
const MIN_CONFIDENCE = 60;
const UPSCALE_MIN_WIDTH = 96;
const UPSCALE_MIN_HEIGHT = 48;
const DEFAULT_REGION_WIDTH = 300;
const DEFAULT_REGION_HEIGHT = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const now = () =>
	typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

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

/**
 * @param {string} [name]
 * @returns {VisionState}
 */
export const createVisionState = (name = 'Vision Region') => ({
	enabled: false,
	name,
	region: {
		x: 0,
		y: 0,
		width: DEFAULT_REGION_WIDTH,
		height: DEFAULT_REGION_HEIGHT
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
	candidateText: '',
	candidateCount: 0,
	loopPromise: null,
	cancelLoop: false,
	frameWidth: 0,
	frameHeight: 0,
	buffers: createVisionBuffers(),
	autoPositioned: false
});

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

const startVisionLoopInternal = (cameraObj, recognizeCanvas, refresh) => {
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
					refresh();
				}

				const clearHighlight = () => {
					const targetVision = cameraObj?.vision;
					if (!targetVision || targetVision.highlightToken !== highlightToken) {
						return;
					}
					if (!targetVision.highlightActive) return;
					targetVision.highlightActive = false;
					refresh();
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
					const candidateCount = candidateMatches ? (vision.candidateCount ?? 0) + 1 : 1;
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
				refresh();
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
			refresh();
		}
	});
};

const stopVisionLoopInternal = (cameraObj, refresh) => {
	const vision = cameraObj?.vision;
	if (!vision) return;
	vision.cancelLoop = true;
	vision.highlightToken = null;
	if (vision.highlightActive) {
		vision.highlightActive = false;
		refresh();
	}
};

const ensureVisionLoopInternal = (cameraObj, startLoop, stopLoop) => {
	const vision = cameraObj?.vision;
	if (!vision) return;

	if (vision.enabled && cameraObj.active && cameraObj.videoEl) {
		startLoop(cameraObj);
	} else if (!vision.enabled || !cameraObj.active) {
		stopLoop(cameraObj);
	}
};

const handleVisionToggleInternal = (cameraObj, enabled, startLoop, stopLoop, refresh) => {
	if (!cameraObj?.vision) return;
	const vision = cameraObj.vision;
	vision.enabled = enabled;
	vision.lastUpdated = 0;
	vision.lastText = '';
	vision.error = null;
	vision.highlightActive = false;
	vision.highlightToken = null;
	if (!enabled) {
		vision.lastPreview = '';
	}
	vision.history = [];
	vision.bestGuess = '';
	vision.historyConfidence = 0;
	vision.lastConfidence = 0;
	vision.candidateText = '';
	vision.candidateCount = 0;
	vision.autoPositioned = false;

	if (!enabled) {
		stopLoop(cameraObj);
	} else {
		startLoop(cameraObj);
	}

	refresh();
};

const updateVisionFieldInternal = (cameraObj, field, value, refresh) => {
	if (!cameraObj?.vision?.region) return;
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return;
	const minValue = field === 'width' || field === 'height' ? 1 : 0;
	cameraObj.vision.region[field] = Math.max(minValue, Math.round(numeric));
	cameraObj.vision.lastUpdated = 0;
	cameraObj.vision.error = null;
	refresh();
};

const updateVisionNameInternal = (cameraObj, value, refresh) => {
	if (!cameraObj?.vision) return;
	cameraObj.vision.name = value;
	refresh();
};

const updateVisionProcessingFieldInternal = (cameraObj, field, value, refresh) => {
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
	refresh();
};

/**
 * @param {object} options
 * @param {(dataUrl: string) => Promise<{ text: string; confidence: number }>} options.recognizeCanvas
 * @param {() => void} options.refresh
 */
export const createVisionController = ({ recognizeCanvas, refresh }) => {
	const doRefresh = typeof refresh === 'function' ? refresh : () => {};

	const startLoop = (cameraObj) => startVisionLoopInternal(cameraObj, recognizeCanvas, doRefresh);
	const stopLoop = (cameraObj) => stopVisionLoopInternal(cameraObj, doRefresh);
	const ensureLoop = (cameraObj) => ensureVisionLoopInternal(cameraObj, startLoop, stopLoop);
	const initializeRegion = (cameraObj) => applyInitialRegionPosition(cameraObj, doRefresh);

	return {
		createState: createVisionState,
		handleToggle: (cameraObj, enabled) =>
			handleVisionToggleInternal(cameraObj, enabled, startLoop, stopLoop, doRefresh),
		updateRegion: (cameraObj, field, value) =>
			updateVisionFieldInternal(cameraObj, field, value, doRefresh),
		updateName: (cameraObj, value) => updateVisionNameInternal(cameraObj, value, doRefresh),
		updateProcessing: (cameraObj, field, value) =>
			updateVisionProcessingFieldInternal(cameraObj, field, value, doRefresh),
		startLoop,
		stopLoop,
		ensureLoop,
		onVideoReady: (cameraObj) => {
			initializeRegion(cameraObj);
			ensureLoop(cameraObj);
		},
		getRectStyle: getVisionRectStyle,
		getTextStyle: getVisionTextStyle,
		initializeRegion
	};
};
/**
 * @param {import('./cameras.js').CameraDescriptor} cameraObj
 * @param {() => void} refresh
 */
const applyInitialRegionPosition = (cameraObj, refresh) => {
	const vision = cameraObj?.vision;
	if (!vision || vision.autoPositioned) return;
	const video = cameraObj?.videoEl;
	if (!video || !video.videoWidth || !video.videoHeight) return;

	const rotation = cameraObj.rotation ?? 0;
	const frameWidth = rotation % 180 === 0 ? video.videoWidth : video.videoHeight;

	if (!vision.region.width) {
		vision.region.width = DEFAULT_REGION_WIDTH;
	}
	if (!vision.region.height) {
		vision.region.height = DEFAULT_REGION_HEIGHT;
	}

	vision.region.x = Math.max(0, Math.round((frameWidth - vision.region.width) / 2));
	vision.region.y = 0;
	vision.autoPositioned = true;
	refresh();
};
