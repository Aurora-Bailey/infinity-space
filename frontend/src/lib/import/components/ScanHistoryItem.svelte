<script>
	export let entry;
	export let formatTimestamp;
</script>

<div
	class="flex items-center opacity-70 justify-between gap-4 text-lg overflow-hidden overflow-x-scroll rounded-md"
	class:bg-emerald-300={entry.status === 'success'}
	class:bg-cyan-600={entry.status === 'pending' || entry.status === 'uploading'}
	class:bg-rose-400={entry.status === 'error'}
>
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
				{#each entry.events as ev (`${ev.timestamp}-${ev.event}`)}
					<div>{formatTimestamp(ev.timestamp)} — {ev.message ?? ev.event}</div>
				{/each}
			</div>
		{/if}
	</div>

	{#each entry.uploads as upload, index (upload.fileName)}
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
