<script>
	import { onMount, onDestroy } from 'svelte';
	import { scanner, scancount } from '$lib/stores/scanner';
	import { toDataURL } from 'qrcode';

	let cameras = [];
	let hist = [];
	let devices = [];

	let last = 0;
	$: if ($scancount !== last) {
		last = $scancount;
		scanEvent();
	}

	const scanEvent = async () => {
		let images = cameras
			.filter((c) => c.active && c.videoEl)
			.map((c) => captureImage(c.videoEl, c.rotation));

		const newEntry = { scan: $scanner, c: $scancount, confirmed: 'no', image: [...images] };
		hist = [...hist, newEntry];

		// Delay confirmation and background update
		setTimeout(async () => {
			const coin = Math.random() > 0.1;
			if (coin) {
				newEntry.confirmed = 'yes';
				hist = [...hist];
				setTimeout(() => {
					hist = hist.filter((entry) => entry.c !== newEntry.c);
					hist = hist.filter((entry) => entry.scan !== newEntry.scan);
				}, 6000);
			} else {
				const qr = await toDataURL(newEntry.scan, {
					errorCorrectionLevel: 'L',
					margin: 2,
					scale: 8,
					color: {
						dark: '#000000',
						light: '#ffffff'
					}
				});
				newEntry.image.push(qr);
				newEntry.confirmed = 'error';
				hist = [...hist];
			}
		}, 3000);
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

		cameraObj.stream = await navigator.mediaDevices.getUserMedia({
			video: {
				deviceId: { exact: cameraObj.device.deviceId },
				width: { ideal: w },
				height: { ideal: h }
			},
			audio: false
		});
		cameraObj.active = true;
		cameras = [...cameras]; // trigger Svelte reactivity
		setTimeout(() => {
			if (cameraObj.videoEl) cameraObj.videoEl.srcObject = cameraObj.stream;
		}, 10);
	};

	const toggleCamera = async (cameraObj) => {
		cameraObj.active ? stopCamera(cameraObj) : startCamera(cameraObj);
		cameras = [...cameras]; // triggers reactive update
	};

	const stopCamera = (cameraObj) => {
		cameraObj.stream?.getTracks().forEach((t) => t.stop());
		cameraObj.stream = null;
		cameraObj.active = false;
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
		await navigator.mediaDevices.getUserMedia({ video: true }); // Trigger permissions
		const allDevices = await navigator.mediaDevices.enumerateDevices();
		devices = allDevices.filter((d) => d.kind === 'videoinput');
		cameras = devices.map((d) => ({
			device: d,
			stream: null,
			videoEl: null,
			active: false,
			rotation: 0,
			landscape: true
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
				on:click={() => toggleCamera(cam)}
			>
				{cam.device.label || 'Unnamed Camera'}
				{cam.active ? '🟢' : '⚪'}
			</button>
		{/each}
	</div>

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
			{/if}
		{/each}
	</div>

	<!-- Scan History -->
	{#if hist.length}
		<div class="w-full flex flex-col gap-2 mt-6">
			{#each [...hist].reverse() as { scan, image, confirmed }, index (index)}
				<div
					class="flex items-center opacity-70 justify-between gap-4 text-lg overflow-hidden overflow-x-scroll rounded-md"
					class:bg-emerald-300={confirmed == 'yes'}
					class:bg-cyan-600={confirmed == 'no'}
					class:bg-rose-400={confirmed == 'error'}
				>
					<!-- Scan overlay -->
					<div
						class="bg-cyan-900 bg-opacity-80 text-white text-sm px-4 py-1 overflow-scroll h-48 rounded-br z-10"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html scan.split('').join('<br>')}
					</div>

					<!-- Images underneath -->
					{#each image as im, index (index)}
						<img src={im} alt="Capture {index + 1}" class="h-48 p-1 rounded" />
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</section>
