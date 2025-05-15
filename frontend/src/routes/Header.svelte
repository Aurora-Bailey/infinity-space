<script>
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { scanner, scancount } from '$lib/stores/scanner';

	let version = 'V1.02 - 043025';
	let open = false;
	let hamburger = false;
	let search = '';
	let select = 0;
	let buffer = ''; // scanner input
	let capturing = false; // scanner
	scanner.set('');

	let actions = [
		{
			name: 'Home',
			type: 'link',
			fav: true,
			ref: '/',
			keywords: ['home', 'back', 'exit', 'reset', 'other']
		},
		{
			name: 'QR',
			type: 'link',
			fav: true,
			ref: '/qr',
			keywords: ['qr', 'fruit', 'tree', 'sweet', 'seeds']
		},
		{
			name: 'QR Nav',
			type: 'link',
			fav: true,
			ref: '/qrnav',
			keywords: ['qr', 'fruit', 'tree', 'sweet', 'seeds']
		},
		{
			name: 'Import',
			type: 'link',
			fav: true,
			ref: '/import',
			keywords: ['add', 'import', 'scan', 'camera', 'idk']
		},
		{
			name: 'About',
			type: 'link',
			fav: true,
			ref: '/about',
			keywords: ['about', 'page', 'other', 'admin', 'arst']
		}
	];

	$: act = actions.filter((f) => {
		if (search.length > 0) return f['name'].toLowerCase().includes(search.toLowerCase());
		else if (hamburger) return f['fav'];
	});

	$: if (browser) {
		document.body.style.overflow = open ? 'hidden' : 'auto';
	}

	onMount(() => {
		const keyboardListener = async (e) => {
			let k = e.key;

			if (!capturing) {
				if (k === 'Escape') toggle(true);

				if (hamburger && k >= '0' && k <= '9') {
					e.preventDefault();
					e.stopPropagation();
					let ki = parseInt(k);
					goto(`${base}${act[ki]['ref']}`);
					closeAll();
				}
				if ((open && k === 'ArrowDown') || k === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					if (k === 'ArrowDown') select++;
					else select--;
					if (select >= act.length) select = act.length - 1;
					if (select < 0) select = 0;
				}
				if (open && k == 'Enter') {
					goto(`${base}${act[select]['ref']}`);
					closeAll();
				}
			}

			// Capture with bluetooth scanner
			if (capturing && k === 'Enter') {
				if (buffer[0] == "/") goto(`${base}${buffer}`);
				scanner.set(buffer);
				scancount.update((n) => n + 1);
				capturing = false;
				buffer = '';
				return;
			}
			if (capturing && k.length === 1) buffer += k;
			if (!capturing && k === '#') capturing = true;
		};

		window.addEventListener('keydown', keyboardListener);
		return () => window.removeEventListener('keydown', keyboardListener);
	});

	function closeAll() {
		open = false;
		hamburger = false;
		reset();
	}
	function reset() {
		search = '';
		select = 0;
		hamburger = false;
	}
	async function toggle(expand) {
		reset();
		open = !open;
		await tick(); // 🔥 wait for DOM update
		if (expand) hamburger = true;
		else {
			const t = document.getElementById('nav-search');
			t?.focus();
		}
	}
</script>

<!-- FOG OVERLAY -->
<!-- A11y: avoid tabindex values above zero -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	on:click={closeAll}
	class="{open
		? ''
		: 'hidden'} fixed top-0 left-0 right-0 bottom-0 inset-0 bg-black/50 backdrop-blur-sm z-40 overflow=auto transition-opacity"
></div>

<!-- Bottom Bar -->
<header class="{open ? '' : 'hidden'} fixed bottom-0 left-0 right-0 bg-zinc-950 text-cyan-400 z-50">
	<nav class="flex flex-col justify-end max-h-[80vh] overflow-hidden">
		<!-- Scroll only this list -->
		<ul class="divide-y divide-cyan-800 overflow-y-auto max-h-full">
			{#each act as a, index (index)}
				<li>
					<a
						href="{base}{a.ref}"
						on:click={closeAll}
						class="block p-4 transition-colors duration-200 cursor-pointer {select === index
							? 'bg-cyan-800/20'
							: 'hover:bg-cyan-800/20'}"
					>
						{hamburger ? '[' + index + ']' : ''}
						{a.name}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<!-- Bottom search bar -->
	<div class="flex items-center justify-between p-3 bg-zinc-950">
		<input
			id="nav-search"
			type="text"
			bind:value={search}
			placeholder="Search..."
			class="flex-1 mx-4 px-3 py-1 rounded bg-zinc-800 text-cyan-200 placeholder-cyan-500 border border-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-400 text-sm"
		/>

		<button
			on:click={() => (hamburger = !hamburger)}
			aria-label="Toggle menu"
			class="relative w-8 h-8 flex flex-col justify-center items-center space-y-1.5"
		>
			<span
				class="w-6 h-0.5 bg-cyan-400 transition-all duration-300"
				class:rotate-45={hamburger}
				class:translate-y-1.5={hamburger}
			></span>
			<span class="w-6 h-0.5 bg-cyan-400 transition-all duration-300" class:opacity-0={hamburger}
			></span>
			<span
				class="w-6 h-0.5 bg-cyan-400 transition-all duration-300"
				class:-rotate-45={hamburger}
				class:-translate-y-1.5={hamburger}
			></span>
		</button>
	</div>
	<div class="flex items-center justify-center">
		Version: {version} Scan: {$scanner} Count: {$scancount}
	</div>
</header>

<!-- Floating Action Button (FAB) -->
<button
	on:click={() => toggle(true)}
	aria-label="Open Menu"
	class="{!open
		? ''
		: 'hidden'} fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-cyan-600 opacity-10 text-white shadow-md hover:shadow-xl transition-all duration-300 flex items-center justify-center backdrop-blur-md"
>
	<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
	</svg>
</button>
<div class="{capturing ? '' : 'hidden'} fixed bottom-6 left-6 z-100">#{buffer}</div>
