/** Splits milliseconds into whole hours, minutes, and seconds. */
export function parts(ms) {
	const total = Math.floor(ms / 1000);
	return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}
