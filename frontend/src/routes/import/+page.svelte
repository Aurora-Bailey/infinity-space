<script>
	import { onMount, onDestroy } from 'svelte';
	import { scanner, scancount } from '$lib/stores/scanner';

	let cameras = [];
	let hist = [];
	let devices = [];
	let cameraError = null;

	let last = 0;
	const MAX_HISTORY = 10;
	const uploadEndpoint = import.meta.env.VITE_UPLOAD_ENDPOINT ?? '/api/import';

	const sanitizeForFilename = (value) => {
		if (!value) return '';
		return value
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toUpperCase();
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
			url: null
		}));

		const entry = {
			scan: scanValue,
			c: $scancount,
			status: uploads.length ? 'pending' : 'error',
			uploads,
			error: uploads.length ? null : 'No active camera images available',
			createdAt: Date.now()
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
					const response = await fetch(uploadEndpoint, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							fileName: upload.fileName,
							contentType: blob.type,
							scan: entry.scan,
							camera: upload.camera,
							timestamp: entry.createdAt
						})
					});

					if (!response.ok) {
						const message = (await response.text()) || response.statusText;
						throw new Error(message);
					}

					const payload = await response.json();
					upload.url = await performS3Upload(payload, blob, upload);
					upload.status = 'success';
					upload.error = null;
				} catch (err) {
					upload.status = 'error';
					upload.error = err instanceof Error ? err.message : 'Upload failed';
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

		if (entry.uploads.some((u) => u.status === 'uploading')) {
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
		hist = [];
		if (!navigator?.mediaDevices?.getUserMedia) {
			cameraError = 'Camera access is not supported in this browser.';
			return;
		}
		try {
			const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true }); // Trigger permissions
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
	});
</script>

<section class="flex flex-col items-center gap-4 p-4">
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
								Uploading...
							{:else if entry.status === 'success'}
								Uploaded
							{:else}
								Upload failed{#if entry.error}: {entry.error}{/if}
							{/if}
						</p>
					</div>

					<!-- Images underneath -->
					{#each entry.uploads as upload, index (index)}
						<div class="flex flex-col items-center">
							<img src={upload.preview} alt="Capture {index + 1}" class="h-48 p-1 rounded" />
							<span class="text-xs text-white px-2">
								CAM{upload.camera}: {upload.status === 'success'
									? 'Uploaded'
									: upload.status === 'uploading'
										? 'Uploading...'
										: upload.status === 'error'
											? `Error${upload.error ? `: ${upload.error}` : ''}`
											: 'Pending'}
							</span>
							<span class="text-[10px] text-white/80 px-2">{upload.fileName}</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</section>
