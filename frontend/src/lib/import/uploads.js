/**
 * @typedef {object} UploadEvent
 * @property {string} event
 * @property {string} [message]
 * @property {string} [timestamp]
 * @property {Record<string, unknown>} [data]
 */

/**
 * @typedef {object} UploadRecord
 * @property {number} camera
 * @property {string} preview
 * @property {string} fileName
 * @property {'pending' | 'uploading' | 'analyzing' | 'success' | 'error'} status
 * @property {string | null} error
 * @property {string | null} url
 * @property {unknown} analysis
 * @property {string | null} analysisError
 * @property {UploadEvent[]} [statusMessages]
 * @property {string} [lastStatus]
 */

/**
 * @typedef {object} UploadEntry
 * @property {string} scan
 * @property {number} c
 * @property {'pending' | 'uploading' | 'success' | 'error'} status
 * @property {string | null} error
 * @property {number} createdAt
 * @property {UploadRecord[]} uploads
 * @property {UploadEvent[]} events
 */

export const MAX_HISTORY = 10;

export const sanitizeForFilename = (value) => {
	if (!value) return '';
	return value
		.replace(/[^a-z0-9]+/gi, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase();
};

export const addEvent = (list = [], event) => {
	if (!event?.timestamp) return list;
	const exists = list.some(
		(existing) => existing.timestamp === event.timestamp && existing.event === event.event
	);
	return exists ? list : [...list, event];
};

export const formatTimestamp = (iso) => {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
	for (let i = 0; i < len; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new Blob([bytes], { type: mime });
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

const createUploads = (scanValue, images, timestamp) => {
	const baseName = sanitizeForFilename(scanValue) || 'BARCODE';
	return images.map((dataUrl, idx) => ({
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
};

/**
 * @param {UploadEvent} payload
 * @returns {UploadEvent}
 */
const buildEvent = (payload) => ({
	event: payload.event,
	message: payload.message,
	timestamp: payload.timestamp,
	data: payload.data ?? {}
});

const recordEvent = (entry, upload, eventPayload) => {
	const eventRecord = buildEvent(eventPayload);
	entry.events = addEvent(entry.events ?? [], eventRecord);
	if (upload) {
		upload.statusMessages = addEvent(upload.statusMessages ?? [], eventRecord);
		upload.lastStatus = eventPayload.message || eventPayload.event;
	}
};

/**
 * @param {object} options
 * @param {(type: string, payload: Record<string, unknown>) => Promise<{ data: any }>} options.sendRequest
 * @param {() => void} options.refreshHistory
 * @param {(scan: string) => UploadEntry | undefined} options.findEntry
 */
export const createUploadManager = ({ sendRequest, refreshHistory, findEntry }) => {
	const doRefresh = typeof refreshHistory === 'function' ? refreshHistory : () => {};
	const locateEntry = typeof findEntry === 'function' ? findEntry : () => undefined;

	const uploadEntry = async (entry) => {
		if (!entry.uploads.length) {
			entry.status = 'error';
			entry.error = 'No camera images available for upload';
			doRefresh();
			return;
		}

		entry.status = 'uploading';
		entry.error = null;
		doRefresh();

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
				doRefresh();

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
					doRefresh();

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

					recordEvent(entry, upload, {
						event: 'client.error',
						message,
						timestamp: new Date().toISOString(),
						data: {}
					});
				} finally {
					doRefresh();
				}
			})
		);

		updateEntryStatus(entry);
		doRefresh();
	};

	const handleStatus = (status) => {
		const { scan, fileName, message, event, timestamp, data } = status ?? {};
		if (!scan) return;
		/** @type {UploadEntry | undefined} */
		const entry = locateEntry(scan);
		if (!entry) return;

		const upload = fileName ? entry.uploads.find((u) => u.fileName === fileName) : undefined;
		recordEvent(entry, upload, { event, message, timestamp, data });

		if (upload) {
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

		if (event === 'analysis.completed') {
			entry.status = 'success';
			entry.error = null;
		}

		if (event && event.includes('error')) {
			entry.status = 'error';
			entry.error = message ?? event;
		}

		updateEntryStatus(entry);
		doRefresh();
	};

	const createEntry = ({ scanValue, scancount, images }) => {
		const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '');
		const uploads = createUploads(scanValue, images, timestamp);
		return {
			scan: scanValue,
			c: scancount,
			status: uploads.length ? 'pending' : 'error',
			uploads,
			error: uploads.length ? null : 'No active camera images available',
			createdAt: Date.now(),
			events: []
		};
	};

	return {
		createEntry,
		uploadEntry,
		handleStatus
	};
};
