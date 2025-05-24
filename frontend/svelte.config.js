import adapter from '@sveltejs/adapter-auto';
import adapterStatic from '@sveltejs/adapter-static';
const dev = process.env.NODE_ENV === 'development';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: dev
			? adapter()
			: adapterStatic({
					fallback: 'index.html' // SPA fallback for GitHub Pages
				}),
		paths: { base: dev ? '' : '/infinity-space' },
		prerender: {
			handleHttpError: 'warn', // allow 404s during prerender, don't crash build
			origin: dev ? 'http://localhost:5173' : 'https://aurora-bailey.github.io'
		},
		appDir: 'internal'
	}
};

export default config;
