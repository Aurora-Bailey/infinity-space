/**
 * @typedef {import('./vision.js').VisionState} VisionState
 */

/**
 * @typedef {object} CameraDescriptor
 * @property {MediaDeviceInfo} device
 * @property {MediaStream | null} stream
 * @property {HTMLVideoElement | null} videoEl
 * @property {boolean} active
 * @property {number} rotation
 * @property {boolean} landscape
 * @property {string | null} error
 * @property {VisionState | null} vision
 */

/**
 * @param {MediaDeviceInfo} device
 * @param {number} index
 * @param {(label: string) => VisionState} [createVisionState]
 * @returns {CameraDescriptor}
 */
export const createCameraDescriptor = (device, index, createVisionState) => ({
	device,
	stream: null,
	videoEl: null,
	active: false,
	rotation: 0,
	landscape: true,
	error: null,
	vision: createVisionState ? createVisionState(`CAM${index + 1} Vision`) : null
});

const setVideoSource = (camera, stream) => {
	if (!camera?.videoEl) return;
	camera.videoEl.srcObject = stream;
};

const stopStreamTracks = (stream) => {
	stream?.getTracks().forEach((track) => track.stop());
};

const captureFromVideo = (video, rotation = 0) => {
	if (!video) return null;

	const width = video.videoWidth;
	const height = video.videoHeight;

	if (!width || !height) return null;

	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');

	if (!ctx) return null;

	if (rotation % 180 === 0) {
		canvas.width = width;
		canvas.height = height;
	} else {
		canvas.width = height;
		canvas.height = width;
	}

	ctx.save();
	ctx.translate(canvas.width / 2, canvas.height / 2);
	ctx.rotate((rotation * Math.PI) / 180);
	ctx.drawImage(video, -width / 2, -height / 2);
	ctx.restore();

	return canvas.toDataURL('image/png');
};

/**
 * @param {object} options
 * @param {() => void} options.refresh
 * @param {{
 * 	ensureLoop?: (camera: CameraDescriptor) => void;
 * 	stopLoop?: (camera: CameraDescriptor) => void;
 }} options.vision
 */
export const createCameraController = ({ refresh, vision }) => {
	const doRefresh = typeof refresh === 'function' ? refresh : () => {};
	const visionApi = vision ?? {};

	const rotate = (cameraObj) => {
		if (!cameraObj) return;
		cameraObj.rotation = (cameraObj.rotation + 90) % 360;
		doRefresh();
	};

	const start = async (cameraObj, w = 3840, h = 2160) => {
		if (!cameraObj || cameraObj.active) return;

		let width = w;
		let height = h;

		if (!cameraObj.landscape) {
			[width, height] = [height, width];
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {
					deviceId: { exact: cameraObj.device.deviceId },
					width: { ideal: width },
					height: { ideal: height }
				},
				audio: false
			});

			cameraObj.stream = stream;
			cameraObj.active = true;
			cameraObj.error = null;
			doRefresh();

			setTimeout(() => {
				setVideoSource(cameraObj, stream);
				if (visionApi.ensureLoop) {
					visionApi.ensureLoop(cameraObj);
				}
			}, 10);
		} catch (err) {
			cameraObj.active = false;
			cameraObj.stream = null;
			cameraObj.error = err instanceof Error ? err.message : 'Unable to start camera';
			if (visionApi.stopLoop) {
				visionApi.stopLoop(cameraObj);
			}
			doRefresh();
		}
	};

	const stop = (cameraObj) => {
		if (!cameraObj) return;
		stopStreamTracks(cameraObj.stream);
		cameraObj.stream = null;
		cameraObj.active = false;
		cameraObj.error = null;
		if (cameraObj.videoEl) {
			cameraObj.videoEl.srcObject = null;
		}
		if (visionApi.stopLoop) {
			visionApi.stopLoop(cameraObj);
		}
		doRefresh();
	};

	const toggle = (cameraObj) => {
		if (!cameraObj) return;
		if (cameraObj.active) {
			stop(cameraObj);
		} else {
			start(cameraObj);
		}
	};

	const capture = (cameraObj) => captureFromVideo(cameraObj?.videoEl, cameraObj?.rotation ?? 0);

	return {
		rotate,
		start,
		stop,
		toggle,
		capture,
		captureFromVideo,
		setVideoSource
	};
};
