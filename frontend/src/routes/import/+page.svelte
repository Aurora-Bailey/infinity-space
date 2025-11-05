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
	import { createVisionController } from '$lib/import/vision';
	import { createCameraController, createCameraDescriptor } from '$lib/import/cameras';
	import { createUploadManager, MAX_HISTORY, formatTimestamp } from '$lib/import/uploads';
	import CameraPanel from '$lib/import/components/CameraPanel.svelte';
	import ScanHistoryItem from '$lib/import/components/ScanHistoryItem.svelte';

	let cameras = [];
	let hist = [];
	let devices = [];
	let cameraError = null;

	let last = 0;
	let connection = { connected: false, connecting: true, attempts: 0, lastError: null };
	let connectionUnsubscribe = () => {};
	let statusUnsubscribe = () => {};
	let snapshotUnsubscribe = () => {};

	const refreshCameras = () => {
		cameras = [...cameras];
	};

	const refreshHistory = () => {
		hist = [...hist];
	};

	const visionController = createVisionController({
		recognizeCanvas,
		refresh: refreshCameras
	});

	const cameraController = createCameraController({
		refresh: refreshCameras,
		vision: visionController
	});

	const uploadManager = createUploadManager({
		sendRequest,
		refreshHistory,
		findEntry: (scan) => hist.find((item) => item.scan === scan)
	});

	const {
		handleToggle: handleVisionToggle,
		updateRegion: updateVisionField,
		updateName: updateVisionName,
		updateProcessing: updateVisionProcessingField,
		onVideoReady,
		getRectStyle: getVisionRectStyle,
		getTextStyle: getVisionTextStyle
	} = visionController;

	const {
		rotate: rotateCamera,
		toggle: toggleCamera,
		capture: captureImage,
		stop: stopCamera
	} = cameraController;

	const handleStatus = (status) => uploadManager.handleStatus(status);

	$: if ($scancount !== last) {
		last = $scancount;
		scanEvent();
	}

	const scanEvent = () => {
		const scanValue = $scanner?.trim();
		if (!scanValue) return;

		const images = cameras
			.filter((c) => c.active && c.videoEl)
			.map((c) => captureImage(c))
			.filter(Boolean);

		const entry = uploadManager.createEntry({
			scanValue,
			scancount: $scancount,
			images
		});

		hist = [...hist.slice(-(MAX_HISTORY - 1)), entry];
		if (entry.status === 'error') {
			refreshHistory();
			return;
		}

		uploadManager.uploadEntry(entry);
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

		cameras = devices.map((device, idx) =>
			createCameraDescriptor(device, idx, visionController.createState)
		);
	});

	onDestroy(() => {
		cameras.forEach((camera) => stopCamera(camera));
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
		{#each cameras as cam, index (cam.device?.deviceId ?? index)}
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
		{#each cameras as cam, index (cam.device?.deviceId ?? index)}
			{#if cam.active}
				<CameraPanel
					camera={cam}
					{rotateCamera}
					{onVideoReady}
					{handleVisionToggle}
					{updateVisionField}
					{updateVisionProcessingField}
					{updateVisionName}
					{getVisionRectStyle}
					{getVisionTextStyle}
				/>
			{:else if cam.error}
				<div class="text-sm text-rose-400 max-w-xs">{cam.error}</div>
			{/if}
		{/each}
	</div>

	<!-- Scan History -->
	{#if hist.length}
		<div class="w-full flex flex-col gap-2 mt-6">
			{#each [...hist].reverse() as entry (entry.c)}
				<ScanHistoryItem {entry} {formatTimestamp} />
			{/each}
		</div>
	{/if}
</section>
