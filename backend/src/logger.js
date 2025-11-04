const RESET = '\x1b[0m';
const LABEL_COLOR = '\x1b[95m';
const SUCCESS_COLOR = '\x1b[92m';
const FAIL_COLOR = '\x1b[91m';
const MAX_LENGTH = 100;

export const shorten = (value = '', max = 32) => {
	if (!value) return '';
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
};

export const neonLog = (label, status, detail = '') => {
	const statusUpper = status === 'success' ? 'SUCCESS' : 'FAIL';
	const prefixPlain = `NEON[${label}] ${statusUpper} `;
	const maxDetailLen = Math.max(0, MAX_LENGTH - prefixPlain.length);
	let detailText = detail;
	if (detailText.length > maxDetailLen) {
		if (maxDetailLen > 3) {
			detailText = `${detailText.slice(0, maxDetailLen - 3)}...`;
		} else {
			detailText = detailText.slice(0, maxDetailLen);
		}
	}

	const labelText = `${LABEL_COLOR}NEON[${label}]${RESET}`;
	const statusText =
		status === 'success'
			? `${SUCCESS_COLOR}SUCCESS${RESET}`
			: `${FAIL_COLOR}FAIL${RESET}`;

	console.log(`${labelText} ${statusText} ${detailText}`);
};
