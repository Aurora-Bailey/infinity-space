<script>
import { onMount, onDestroy } from 'svelte';
import { scanner, scancount } from '$lib/stores/scanner';
import { sendRequest, subscribeStatus, subscribeSnapshot, wsConnection, connect as ensureWebSocket } from '$lib/wsClient';

let cameras = [];
let hist = [];
let devices = [];
let cameraError = null;

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
	const exists = list.some((existing) => existing.timestamp === event.timestamp && existing.event === event.event);
	return exists ? list : [...list, event];
};

const formatTimestamp = (iso) => {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
				if (cameraObj.videoEl) cameraObj.videoEl.srcObject = cameraObj.stream;
			}, 10);
		} catch (err) {
			cameraObj.active = false;
			cameraObj.stream = null;
			cameraObj.error = err instanceof Error ? err.message : 'Unable to start camera';
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

	cameras = devices.map((d) => ({
		device: d,
		stream: null,
		videoEl: null,
		active: false,
		rotation: 0,
		landscape: true,
		error: null
	}));
});

onDestroy(() => {
	cameras.forEach((c) => stopCamera(c));
	connectionUnsubscribe();
	statusUnsubscribe();
	snapshotUnsubscribe();
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
				<div>
					<!-- svelte-ignore a11y_media_has_caption -->
					<!-- svelte-ignore element_invalid_self_closing_tag -->
					<video
						bind:this={cam.videoEl}
						autoplay
						playsinline
						on:click={() => rotateCamera(cam)}
						class="rounded shadow transition-transform duration-300 cursor-pointer"
						style="transform: rotate({cam.rotation}deg);"
					/>
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
