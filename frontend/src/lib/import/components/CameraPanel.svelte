<script>
	export let camera;
	export let rotateCamera;
	export let onVideoReady;
	export let handleVisionToggle;
	export let updateVisionField;
	export let updateVisionProcessingField;
	export let updateVisionName;
	export let getVisionRectStyle;
	export let getVisionTextStyle;

	let videoEl;
	let hasSufficientText = false;

	$: if (camera) {
		camera.videoEl = videoEl;
	}

	$: hasSufficientText = Boolean(camera?.vision?.lastText?.trim().length > 4);
</script>

<div class="flex flex-col items-center gap-2">
	<div
		class="relative inline-block transition-transform duration-300"
		style="transform: rotate({camera.rotation}deg); transform-origin: center;"
	>
		<!-- svelte-ignore a11y_media_has_caption -->
		<!-- svelte-ignore element_invalid_self_closing_tag -->
		<video
			bind:this={videoEl}
			autoplay
			playsinline
			on:click={() => rotateCamera(camera)}
			on:loadedmetadata={() => onVideoReady(camera)}
			class="rounded shadow cursor-pointer block"
		/>
		{#if camera.vision?.enabled}
			{#if getVisionRectStyle(camera)}
				<div
					class="absolute pointer-events-none border-2 transition-colors duration-100"
					class:border-green-500={hasSufficientText}
					class:border-red-500={!hasSufficientText}
					style={getVisionRectStyle(camera)}
				></div>
				<div
					class="absolute pointer-events-none bg-black/80 text-red-200 text-xs px-2 py-1 rounded translate-y-1 text-center"
					style={getVisionTextStyle(camera)}
				>
					Vision: {camera.vision.name || 'Region'} — {camera.vision.lastText || '…'}
				</div>
			{/if}
		{/if}
	</div>
	<div class="w-full max-w-xs text-xs text-white/80 space-y-2">
		<label class="flex items-center gap-2">
			<input
				type="checkbox"
				checked={camera.vision?.enabled}
				on:change={(event) => handleVisionToggle(camera, event.currentTarget.checked)}
			/>
			Enable Vision
		</label>
		{#if camera.vision?.enabled}
			<div class="grid grid-cols-2 gap-2">
				<label class="flex flex-col gap-1">
					<span>X</span>
					<input
						type="number"
						min="0"
						value={camera.vision.region.x}
						on:input={(event) => updateVisionField(camera, 'x', event.currentTarget.value)}
						class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span>Y</span>
					<input
						type="number"
						min="0"
						value={camera.vision.region.y}
						on:input={(event) => updateVisionField(camera, 'y', event.currentTarget.value)}
						class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span>Width</span>
					<input
						type="number"
						min="1"
						value={camera.vision.region.width}
						on:input={(event) => updateVisionField(camera, 'width', event.currentTarget.value)}
						class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span>Height</span>
					<input
						type="number"
						min="1"
						value={camera.vision.region.height}
						on:input={(event) => updateVisionField(camera, 'height', event.currentTarget.value)}
						class="rounded bg-slate-900/80 px-2 py-1 text-white focus:outline-none focus:ring focus:ring-sky-500/40"
					/>
				</label>
				<label class="flex flex-col gap-1 col-span-2">
					<span>Name</span>
					<input
						type="text"
						value={camera.vision.name}
						on:input={(event) => updateVisionName(camera, event.currentTarget.value)}
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
						value={camera.vision.processing?.contrast ?? 1}
						on:input={(event) =>
							updateVisionProcessingField(camera, 'contrast', event.currentTarget.value)}
					/>
					<span class="text-[10px] text-white/70">
						{(camera.vision.processing?.contrast ?? 1).toFixed(1)}×
					</span>
				</label>
				<label class="flex flex-col gap-1">
					<span>Threshold</span>
					<input
						type="number"
						min="0"
						max="255"
						step="1"
						value={camera.vision.processing?.threshold ?? ''}
						on:input={(event) =>
							updateVisionProcessingField(camera, 'threshold', event.currentTarget.value)}
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
						value={camera.vision.processing?.sharpen ?? 0}
						on:input={(event) =>
							updateVisionProcessingField(camera, 'sharpen', event.currentTarget.value)}
					/>
					<span class="text-[10px] text-white/70">
						{(camera.vision.processing?.sharpen ?? 0).toFixed(2)}
					</span>
				</label>
			</div>
			{#if camera.vision.lastPreview}
				<div class="flex flex-col gap-1">
					<span>Preview</span>
					<img
						src={camera.vision.lastPreview}
						alt={`Vision preview for ${camera.vision.name || 'Region'}`}
						class="rounded border border-emerald-400/40 bg-black/60 max-h-32 object-contain"
					/>
				</div>
			{/if}
			<div class="text-[10px] text-white/60">
				Confidence: {Math.round(camera.vision.lastConfidence ?? 0)}%
			</div>
			<div class="text-[11px] text-emerald-200/90">
				Vision: {camera.vision.name || 'Region'} — {camera.vision.lastText || '…'}
			</div>
			{#if camera.vision.error}
				<div class="text-[11px] text-rose-300">
					{camera.vision.error}
				</div>
			{/if}
		{/if}
	</div>
</div>
