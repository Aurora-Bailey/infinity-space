<script>
	import { onMount } from 'svelte';
	import { toDataURL } from 'qrcode';
	import JsBarcode from 'jsbarcode';
	import { browser } from '$app/environment';

	$: if (
		browser &&
		start >= 0 &&
		count > 0 &&
		typeof unique !== 'undefined' &&
		typeof type !== 'undefined' &&
		typeof prefix !== 'undefined'
	) {
		generateLabels();
	}

	const qrPrepend = '';
	const barcodePretend = '';

	let prefix = 'H';
	let start = 10000;
	let count = 50;
	let unique = true;
	let type = 'barcode';

	let items = [];
	let labels = [];

	const qrOptions = {
		errorCorrectionLevel: 'L',
		margin: 0,
		scale: 4,
		color: {
			dark: '#000000',
			light: '#ffffff'
		}
	};

	async function generateLabels() {
		items = [];
		for (let i = 0; i < count; i++) {
			let n = start + (unique ? i : 0);
			// const letter = String.fromCharCode((n % 26) + 65);
			items.push(`${prefix}${n == 0 ? '' : n}`); // -${letter}`);
		}

		labels = await Promise.all(
			items.map(async (text) => {
				const canvas = document.createElement('canvas');
				canvas.width = 1440 / 4; // resolution of barcode
				canvas.height = 960 / 4.23;
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = '#fff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);

				if (type === 'barcode') {
					const barcodeCanvas = document.createElement('canvas');
					JsBarcode(barcodeCanvas, barcodePretend + text, {
						format: 'CODE39',
						width: (7 * canvas.width) / 1440,
						height: canvas.width / 3,
						displayValue: false,
						margin: (100 * canvas.width) / 1440,
						background: '#ffffff',
						lineColor: '#000000'
					});
					ctx.drawImage(barcodeCanvas, (80 * canvas.width) / 1440, canvas.height / 4);
					ctx.translate(canvas.width / 2, canvas.height / 4);
					ctx.font = `${(100 * canvas.width) / 1440}px sans-serif`;
					ctx.fillStyle = '#000';
					ctx.textAlign = 'center';
					ctx.fillText(text, 0, 0);
					ctx.font = `${(70 * canvas.width) / 1440}px sans-serif`;
					ctx.fillStyle = '#999';
					ctx.fillText(barcodePretend, 0, (canvas.height / 12) * 1);
				} else {
					const qrDataUrl = await toDataURL(qrPrepend + text, qrOptions);
					const qrImg = new Image();
					qrImg.src = qrDataUrl;
					await qrImg.decode();
					ctx.drawImage(
						qrImg,
						(canvas.width / 9) * 1.7,
						(canvas.height / 6) * 1,
						(canvas.width / 9) * 4,
						(canvas.height / 6) * 4
					);
					ctx.translate((canvas.width / 9) * 7, canvas.height / 2);
					ctx.rotate(Math.PI / 2);
					ctx.font = `${(100 * canvas.width) / 1440}px sans-serif`;
					ctx.fillStyle = '#000';
					ctx.textAlign = 'center';
					ctx.fillText(text, 0, (-canvas.width / 9) * 0.1);
					ctx.font = `${(70 * canvas.width) / 1440}px sans-serif`;
					ctx.fillStyle = '#999';
					ctx.fillText(qrPrepend, 0, (canvas.width / 9) * 1.1);
				}
				return { text, dataUrl: canvas.toDataURL() };
			})
		);
	}

	onMount(() => {
		generateLabels();
	});
</script>

<svelte:head>
	<link
		href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<section class="text-white p-0 m-auto max-w-[650px] print:w-[100%]">
	<div class="print:hidden flex flex-wrap gap-4 mb-4">
		<div class="flex w-[120px] flex-col">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="text-sm font-medium">Prefix</label>
			<input type="text" bind:value={prefix} class="border p-1 rounded" />
		</div>
		<div class="flex w-[120px] flex-col">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="text-sm font-medium">Start</label>
			<input type="number" bind:value={start} class="border p-1 rounded" />
		</div>

		<div class="flex w-[120px] flex-col">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="text-sm font-medium">Quant</label>
			<input type="number" bind:value={count} class="border p-1 rounded" />
		</div>

		<button
			on:click={() => (unique = !unique)}
			class="w-[120px] rounded shadow transition"
			class:bg-cyan-400={unique}
			class:bg-red-700={!unique}
		>
			{unique ? 'Unique' : 'Identical'}
		</button>

		<button
			on:click={() => (type = type == 'barcode' ? 'qrcode' : 'barcode')}
			class="w-[120px] rounded shadow transition"
			class:bg-orange-700={type == 'barcode'}
			class:bg-green-700={type == 'qrcode'}
		>
			{type == 'barcode' ? 'Barcode' : 'QR Code'}
		</button>

		<button on:click={() => window.print()} class="w-[120px] bg-gray-800 rounded shadow transition">
			📄 Print
		</button>
	</div>
	<!-- Rendered Labels -->
	<div
		class="grid grid-cols-5 gap-0 w-[100%] h-[100%]"
	>
		{#each labels as { dataUrl }, index (index)}
			<img
				src={dataUrl}
				alt="Label {index}"
				class="w-[100%] h-[100%] outline-1 print:outline-0"
				class:outline-cyan-400={unique}
				class:outline-red-700={!unique}
			/>
		{/each}
	</div>
</section>
