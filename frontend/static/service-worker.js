self.addEventListener('install', (event) => {
	console.log('Service worker installed.', event);
});

self.addEventListener('fetch', (event) => {
	// Optional: Cache logic goes here
	console.log(event);
});
